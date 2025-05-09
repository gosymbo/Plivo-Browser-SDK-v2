/* eslint-disable import/no-cycle */
/* eslint-disable no-underscore-dangle */
import * as SipLib from 'plivo-jssip';
import * as C from '../constants';
import { Logger } from '../logger';
import * as pkg from '../../package.json';
import { CallStatsValidationResponse, fetchIPAddress, validateCallStats } from '../stats/httpRequest';
import { createStatsSocket, initCallStatsIO } from '../stats/setup';
import {
  createIncomingSession,
} from './incomingCall';
import { createOutgoingSession } from './outgoingCall';
import { getCurrentTime, addMidAttribute } from './util';
import { stopAudio } from '../media/document';
import { Client } from '../client';
import {
  sendNetworkChangeEvent,
  startPingPong,
  getNetworkData,
  ConnectionState,
  socketReconnectionRetry,
} from '../utils/networkManager';
import { StatsSocket } from '../stats/ws';
import { NoiseSuppression } from '../rnnoise/NoiseSuppression';

const Plivo = { log: Logger };
let urlIndex: number = 0;

/**
 * Initializes the Account.
 */

class Account {
  /**
   * Reference to the client class
   */
  private cs: Client;

  private isPlivoSocketConnected: boolean;

  /**
   * SipLib Message class to execute ping-pong
   */
  private message: any;

  /**
   * Holds the boolean whether failed event is triggered
   */
  isFailedMessageTriggered: boolean;

  /**
   * Holds the boolean whether failed event is triggered
   */
  registerRefreshTimer: number;

  /**
   * Credentials object
   */
  private credentials: {
    userName: string;
    password: string;
  };

  /**
   * Access Token Credentials object
   */
  private accessTokenCredentials: {
    accessToken: string | null;
  };

  /**
   * Hold the value of number of retry counts done
   */
  private fetchIpCount: number;

  /**
   * Validate the account credentials and session.
   */
  public validate = (callback: any):
  boolean => this._validate(callback);

  /**
   * Handles signalling, transport account creation and its listners
   */
  public setupUserAccount = (): void => this._setupUserAccount();

  /**
   * Creates signalling transport and account.
   */
  public create = (): boolean => this._create();

  /**
   * Creates account, transport event listeners.
   */
  public createListeners = (): void => this._createListeners();

  // for qa purpose
  reinviteCounter: number;

  /**
   * @construtor
   * @param {Client} clientObject - client reference
   * @param {String} userName
   * @param {String} password
   * @private
   */
  constructor(clientObject: Client, userName: string, password: string,
    accessToken: string | null, registerRefreshtimer: number) {
    this.cs = clientObject;
    this.credentials = { userName, password };
    this.accessTokenCredentials = { accessToken };
    this.message = null;
    this.registerRefreshTimer = registerRefreshtimer;
    // for qa purpose
    this.reinviteCounter = 0;
    this.isPlivoSocketConnected = false;
    this.fetchIpCount = 0;
  }

  private _validate = (callback: () => void): any => {
    if (
      typeof this.credentials.userName === 'undefined'
      || typeof this.credentials.password === 'undefined'
      || this.credentials.userName === null
      || (this.credentials.password === null
        && (this.credentials.userName.length <= 0
          || (this.credentials.password as string).length <= 0))
    ) {
      Plivo.log.error(`${C.LOGCAT.LOGIN} | username and password cannot be null.`);
      this.cs.emit('onLoginFailed', 'Username and password must be filled out');
      return false;
    }
    if (this.cs._currentSession) {
      Plivo.log.warn(
        `${C.LOGCAT.LOGIN} | Cannot login when there is an ongoing call ${this.cs._currentSession.callUUID}`,
      );
      this.cs.emit(
        'onLoginFailed',
        'Cannot login when there is an ongoing call',
      );
      return false;
    }

    if (!navigator.onLine) {
      Plivo.log.warn(
        `${C.LOGCAT.LOGIN} | Cannot login when there is no internet`,
      );
      this.cs.emit(
        'onLoginFailed',
        'Cannot login when there is no internet',
      );
      return false;
    }
    // On login failure retry.
    if (this.cs.phone) {
      this.cs.loginCallback = callback;
      Plivo.log.debug(`${C.LOGCAT.LOGIN} | deleting the existing phone instance`);
      this.cs.phone.stop();
      this.cs.connectionInfo = {
        state: ConnectionState.DISCONNECTED,
        reason: "Relogin",
      };
      return this.cs.loginCallback;
    }
    return true;
  };

  private sendReInvite = () => {
    Plivo.log.debug(`${C.LOGCAT.LOGIN} | reInvite initiated`);
    if (this.cs._currentSession && this.cs.phone) {
      // replace current session ua with newly created ua
      this.cs._currentSession.session.replaceUA(this.cs.phone);
      setTimeout(() => {
        const eventHandlers = {
          succeeded: () => { },
          failed: () => { },
        };
        // this.cs._currentSession!.session = session;
        this.reinviteCounter += 1;
        this.cs._currentSession!.session._sendReinvite({
          eventHandlers,
          rtcOfferConstraints: { iceRestart: true },
        });
      }, 0);
    }
  };

  private setupUAConfig = () => {
    this.cs.plivoSocket = null as any;
    // look for custom domain in init options
    let wsServers = C.WS_SERVERS;
    if (this.cs.options.registrationDomainSocket) {
      wsServers = this.cs.options.registrationDomainSocket;
      if (typeof (this.cs.options.registrationDomainSocket) === 'string') {
        wsServers = (this.cs.options.registrationDomainSocket as string).split(',');
      } else {
        wsServers = this.cs.options.registrationDomainSocket;
      }
    }
    if (urlIndex >= wsServers.length) {
      urlIndex = 0;
    }
    Plivo.log.debug(`${C.LOGCAT.LOGIN} | Connecting WS with domain ${wsServers[urlIndex]}`);
    this.cs.plivoSocket = new SipLib.WebSocketInterface(wsServers[urlIndex]) as any;
    const sipConfig = {
      sockets: [this.cs.plivoSocket],
      register_expires: this.registerRefreshTimer,
      uri: `${this.credentials.userName}@${C.DOMAIN}`,
      password: this.credentials.password,
      token: this.accessTokenCredentials.accessToken,
      googIPv6: false,
      connection_recovery_max_interval: C.WS_RECOVERY_MAX_INTERVAL,
      connection_recovery_min_interval: C.WS_RECOVERY_MIN_INTERVAL,
      session_timers: false,
      user_agent: `${pkg.name} ${pkg.version}`,
    };
    return sipConfig;
  };

  private _setupUserAccount = () => {
    const isCreated = this._create();
    if (!isCreated) return;
    Plivo.log.info('Ready to login');
    Plivo.log.debug(`${C.LOGCAT.CALL} | Establishing user accounts and configuring the callback listener`);
    this._createListeners();
    if (this.cs.phone) {
      if (this.accessTokenCredentials.accessToken != null) {
        this.cs.phone.registrator().setExtraHeaders([
          `X-Plivo-Jwt: ${this.accessTokenCredentials.accessToken}`,
        ]);
      }
      socketReconnectionRetry(this.cs);
      this.cs.phone.start();
    }
  };

  private _create = (): boolean => {
    const sipConfig = this.setupUAConfig();
    try {
      this.cs.phone = new SipLib.UA(sipConfig);
      return true;
    } catch (e) {
      Plivo.log.debug(`${C.LOGCAT.LOGIN} | Failed to create user agent ${e.message}`);
      this.cs.emit('onLoginFailed', 'Failed to create user agent');
      return false;
    }
  };

  private tiggerNetworkChangeEvent = () => {
    this.fetchIpCount += 1;
    fetchIPAddress(this.cs).then((ipAddress) => {
      if (typeof ipAddress === "string") {
        sendNetworkChangeEvent(this.cs, ipAddress);
      } else if (this.fetchIpCount !== C.IP_ADDRESS_FETCH_RETRY_COUNT) {
        setTimeout(() => {
          this.tiggerNetworkChangeEvent();
        }, this.fetchIpCount * 200);
      } else {
        Plivo.log.warn(`${C.LOGCAT.NETWORK_CHANGE} | Could not retreive ipaddress`);
        this.fetchIpCount = 0;
      }
    });
  };

  private _createListeners = (): void => {
    if (this.cs.phone) {
      this.cs.phone.on('connected', this._onConnected);
      this.cs.phone.on('disconnected', this._onDisconnected);
      this.cs.phone.on('registered', this._onRegistered);
      this.cs.phone.on('unregistered', this._onUnRegistered);
      this.cs.phone.on('registrationFailed', this._onRegistrationFailed);
      this.cs.phone.on('newTransaction' as any, this._onNewTransaction);
      this.cs.phone.on('newRTCSession', this._onNewRTCSession);
    }
  };

  /**
   * Triggered when web socket is connected.
   * @param {UserAgentConnectedEvent} evt
   */
  private _onConnected = (evt: SipLib.UserAgentConnectedEvent): void => {
    Plivo.log.debug('websocket connection established', evt);
    Plivo.log.info(`${C.LOGCAT.WS} | websocket connection established`);

    if (this.cs.connectionRetryInterval) {
      Plivo.log.info(`${C.LOGCAT.LOGIN} | websocket connected. Clearing the connection check interval`);
      clearInterval(this.cs.connectionRetryInterval);
      this.cs.connectionRetryInterval = null;
    }
    if (!this.isPlivoSocketConnected) {
      this.isPlivoSocketConnected = true;
      if (!this.cs.didFetchInitialNetworkInfo) {
        fetchIPAddress(this.cs).then((ip) => {
          this.cs.currentNetworkInfo = {
            networkType: (navigator as any).connection
              ? (navigator as any).connection.effectiveType
              : 'unknown',
            ip: typeof ip === "string" ? ip : '',
          };
        }).catch(() => {
          this.cs.currentNetworkInfo = {
            networkType: (navigator as any).connection
              ? (navigator as any).connection.effectiveType
              : 'unknown',
            ip: "",
          };
        });
        this.cs.didFetchInitialNetworkInfo = true;
      }
    }
  };

  /**
   * Triggered when web socket is disconnected.
   * @param {UserAgentDisconnectedEvent} evt
   */
  private _onDisconnected = (evt: SipLib.UserAgentDisconnectedEvent): void => {
    Plivo.log.info(`${C.LOGCAT.LOGOUT} | WebSocket Connection Closed - Code: ${evt.code ?? 'Unknown code'}, Reason: ${evt.reason ?? 'No reason provided'}, Socket URL: ${evt.socket.url}`);
    if (evt.code) {
      this.cs.connectionInfo = {
        state: ConnectionState.DISCONNECTED,
        reason: evt.code.toString(),
      };
    }
    if (this.isPlivoSocketConnected) {
      this.isPlivoSocketConnected = false;
    }
    if (this.cs.loginCallback) {
      Plivo.log.debug(`${C.LOGCAT.LOGOUT} |  Previous connection disconnected successfully, starting a new one.`);
      this.cs.loginCallback();
      this.cs.loginCallback = null;
    }
    if (!(evt as any).ignoreReconnection) {
      Plivo.log.debug(`${C.LOGCAT.LOGIN} | starting new transport`);
      urlIndex += 1;
      socketReconnectionRetry(this.cs);
      const sipConfig = this.setupUAConfig();
      this.cs.phone!.createNewUATransport(sipConfig);
      this.cs.phone!.start();
      this.sendReInvite();
    }
  };

  /**
   * Triggered when the user is logged in.
   */
  private _onRegistered = (res: any): void => {
    // Parse the response to get the JWT expiry in epoch
    // below is the example to get basic 120 sec expiry from response
    // To do : This needs to be changed in case of login through access Token method
    if (this.cs._currentSession && this.cs.isCallMuted) {
      Plivo.log.info(`${C.LOGCAT.CALL} | Speech Recognition restarted after network disruption`);
      this.cs._currentSession.startSpeechRecognition(this.cs);
    }
    if (this.cs.loginCallback) {
      this.cs.loginCallback = null;
    }
    this.cs.connectionInfo = {
      state: ConnectionState.CONNECTED,
      reason: 'registered',
    };
    Plivo.log.debug(`${C.LOGCAT.WS} |  websocket connected: ${this.cs.connectionInfo.reason}`);
    this.cs.emit('onConnectionChange', { ...this.cs.connectionInfo });
    if (this.cs.isAccessToken && res.response.headers['X-Plivo-Jwt']) {
      const expiryTimeInEpoch = res.response.headers['X-Plivo-Jwt'][0].raw.split(";")[0].split("=")[1];
      this.cs.setExpiryTimeInEpoch(expiryTimeInEpoch * 1000);
    }
    if (!this.cs.isLoggedIn && !this.cs.isLoginCalled) {
      Plivo.log.info(`${C.LOGCAT.NETWORK_CHANGE} | Network changed happened. re-starting the OPTIONS interval`);

      // this is case of network change
      clearInterval(this.cs.networkChangeInterval as any);
      this.cs.networkChangeInterval = null;
      startPingPong({
        client: this.cs,
        networkChangeInterval: this.cs._currentSession
          ? C.NETWORK_CHANGE_INTERVAL_ON_CALL_STATE : C.NETWORK_CHANGE_INTERVAL_IDLE_STATE,
        messageCheckTimeout: C.MESSAGE_CHECK_TIMEOUT_ON_CALL_STATE,
      });
      if (!this.cs._currentSession) {
        // network changed when call is not active. sending network change stats to nimbus.
        fetchIPAddress(this.cs).then((ipAddress) => {
          const networkInfo = getNetworkData(this.cs, ipAddress);

          Plivo.log.info(`${C.LOGCAT.NETWORK_CHANGE} | Network changed from ${JSON.stringify(networkInfo.previousNetworkInfo).slice(1, -1)}
          to ${JSON.stringify(networkInfo.newNetworkInfo).slice(1, -1)} in idle state`);

          this.cs.currentNetworkInfo = {
            networkType: networkInfo.newNetworkInfo.networkType,
            ip: typeof ipAddress === "string" ? ipAddress : "",
          };
        });
        this.cs.isLoggedIn = true;
        return;
      }

      // create stats socket and trigger and trigger network change event
      // when user is in in-call state
      if (this.cs.statsSocket) {
        this.cs.statsSocket.disconnect();
        this.cs.statsSocket = null;
      }
      this.cs.statsSocket = new StatsSocket();
      this.cs.statsSocket.connect();
      this.cs.networkReconnectionTimestamp = new Date().getTime();
      this.tiggerNetworkChangeEvent();
    }

    if (!this.cs.isLoginCalled) {
      this.cs.isLoggedIn = true;
    }
    this.cs.userName = this.credentials.userName;
    this.cs.password = this.credentials.password;
    if (this.cs.isLoggedIn === false && this.cs.isLoginCalled === true) {
      this.cs.isLoggedIn = true;
      this.cs.isLoginCalled = false;
      // initialize callstats.io
      this.cs.noiseSuppresion = new NoiseSuppression(this.cs);
      this.cs.emit('onLogin');
      Plivo.log.info(`${C.LOGCAT.LOGIN} | User logged in successfully`);
      // in firefox and safari web socket re-establishes automatically after network change
      startPingPong({
        client: this.cs,
        networkChangeInterval: C.NETWORK_CHANGE_INTERVAL_IDLE_STATE,
        messageCheckTimeout: C.MESSAGE_CHECK_TIMEOUT_ON_CALL_STATE,
      });
      // get callstats key and create stats socket
      let passToken: string | null;
      if (this.cs.isAccessToken) {
        passToken = this.cs.accessToken;
      } else {
        this.cs.isAccessToken = false;
        passToken = this.cs.password;
      }
      validateCallStats(this.cs.userName, passToken, this.cs.isAccessToken)
        .then((responsebody: CallStatsValidationResponse) => {
          this.cs.callstatskey = responsebody.data;
          this.cs.rtp_enabled = responsebody.is_rtp_enabled;
        }).catch(() => {
          this.cs.callstatskey = null;
        });
      initCallStatsIO.call(this.cs);
      Plivo.log.send(this.cs);
    }
  };

  /**
   * Triggered when user is logged out.
   * @param {Object} reason - Unregistration reason
   */
  private _onUnRegistered = (): void => {
    this.cs.isLoggedIn = false;
    if (this.cs.connectionInfo.state === "" || this.cs.connectionInfo.state === ConnectionState.CONNECTED) {
      this.cs.connectionInfo = {
        state: ConnectionState.DISCONNECTED,
        reason: "unregistered",
      };
    }
    Plivo.log.debug(`${C.LOGCAT.WS} |  websocket disconnected with reason : ${this.cs.connectionInfo.reason}`);
    this.cs.emit('onConnectionChange', { ...this.cs.connectionInfo });
    if (!this.cs.isLogoutCalled) {
      return;
    }

    Plivo.log.debug(`${C.LOGCAT.LOGOUT} |  Plivo client unregistered`);
    if (this.cs.ringToneView && !this.cs.ringToneView.paused) {
      stopAudio(C.RINGTONE_ELEMENT_ID);
    }
    if (this.cs.ringBackToneView && !this.cs.ringBackToneView.paused) {
      stopAudio(C.RINGBACK_ELEMENT_ID);
    }

    this.cs.networkDisconnectedTimestamp = new Date().getTime();
    this.cs.userName = null;
    this.cs.password = null;
    this.cs.emit('onLogout');
    Plivo.log.info(C.LOGCAT.LOGOUT, ' | Logout successful!');
    if (this.cs.networkChangeInterval) {
      clearInterval(this.cs.networkChangeInterval);
      this.cs.networkChangeInterval = null;
    }
    this.cs.clearOnLogout();
    this.message = null;
    this.cs.isLogoutCalled = false;
    Plivo.log.send(this.cs);
  };

  /**
   * Triggered when user credentials are wrong.
   * @param {Object} error - Login failure error
   */
  private _onRegistrationFailed = (error: { cause?: string, response: any }): void => {
    if (this.cs.connectionInfo.state === ConnectionState.DISCONNECTED && this.cs.isLoggedIn) {
      Plivo.log.debug(`${C.LOGCAT.LOGIN} | Registration failed when state: ${this.cs.connectionInfo.state} and login: ${this.cs.isLoggedIn} with error: `, error.cause, error.response);
      return;
    }
    this.cs.isLoggedIn = false;
    this.cs.userName = null;
    this.cs.password = null;
    const errorCode = error?.response?.headers['X-Plivo-Jwt-Error-Code'] ? parseInt(error?.response?.headers['X-Plivo-Jwt-Error-Code'][0]?.raw, 10) : 401;
    if (error.cause && errorCode === 401) {
      Plivo.log.info(`${C.LOGCAT.LOGIN} | Login failed with error: `, error.cause, error.response);
      this.cs.emit('onLoginFailed', error.cause);
    } else {
      clearInterval(this.cs.networkChangeInterval as any);
      this.cs.networkChangeInterval = null;
      const errorString = this.cs.isAccessTokenGenerator ? "RELOGIN_FAILED_INVALID_TOKEN" : this.cs.getErrorStringByErrorCodes(errorCode);
      Plivo.log.info(`${C.LOGCAT.LOGIN} | Login failed with error: ${errorString}`);
      this.cs.emit('onLoginFailed', errorString);
    }
  };

  /**
   * Triggered when a transaction is created.
   * @param {Any} evt - transaction details
   */
  private _onNewTransaction = (evt: any): void => {
    // NOTE: This event is not documented by JsSIP.
    // Should be used to just record the timestamp of invite received only
    // Do not have any other logic here
    // Invite Server Trasaction(ist) gives us the incoming invite timestamp.
    if (evt.transaction.type === 'ist') {
      const callID = evt.transaction.request.getHeader('Call-ID') ?? "";
      Plivo.log.info(`${C.LOGCAT.LOGIN} | new Transaction created, incoming call received callUUID: ${callID}`);
      this.cs.loggerUtil.setSipCallID(callID);
      Plivo.log.info('<----- INCOMING ----->');
      const callUUID = evt.transaction.request.getHeader('X-Calluuid') || null;
      this.cs.incomingCallsInitiationTime.set(callUUID, getCurrentTime());
      Plivo.log.debug('call initiation time, invite received from server');
    }
  };

  /**
   * Triggered when a new call is performed/received.
   * @param {UserAgentNewRtcSessionEvent} evt
   */
  private _onNewRTCSession = (evt: SipLib.UserAgentNewRtcSessionEvent): void => {
    if (evt.originator === 'local') {
      const sipCallID = (evt.request as SipLib.OutgoingRequest).call_id;
      this.cs.loggerUtil.setSipCallID(sipCallID);
    }
    Plivo.log.debug(`${C.LOGCAT.CALL} | new rtc session created, originator:${evt.originator}`);
    // create stats socket
    createStatsSocket.call(this.cs);
    if (!this._validateRTCSession(evt)) return;

    if (evt.originator === 'remote') {
      addMidAttribute.call(this.cs, evt);
      createIncomingSession(this.cs, evt);
    } else {
      createOutgoingSession(evt);
    }
    this.cs.timeTakenForStats.mediaSetup = {} as any;
    this.cs.timeTakenForStats.mediaSetup.init = new Date().getTime();
  };

  /**
   * Check previous call sessions and incoming call invites.
   * @param {UserAgentNewRtcSessionEvent} evt
   */
  private _validateRTCSession = (evt: SipLib.UserAgentNewRtcSessionEvent): boolean => {
    if (
      this.cs._currentSession
      && this.cs._currentSession.session.connection
      && this.cs._currentSession.session.connection.signalingState === 'closed'
    ) {
      Plivo.log.warn(`${C.LOGCAT.CALL} | Previous call did not end properly`);
      this.cs._currentSession = null;
      this.cs.callSession = null;
      this.cs.callUUID = null;
      this.cs.callDirection = null;
    }
    if (this.cs.incomingInvites.size) {
      Plivo.log.debug(`${C.LOGCAT.CALL} | Remove the incoming call from map if it is failed but not removed properly, invite-size: ${this.cs.incomingInvites?.size ?? "none"}`);
      this.cs.incomingInvites.forEach((invite) => {
        // Remove the incoming call from map if it is failed but not removed properly
        if (invite.session.isEnded()) {
          this.cs.incomingInvites.delete(invite.callUUID);
        }
      });
    }
    if (
      ((this.cs._currentSession || this.cs.incomingInvites.size)
        && !this.cs.options.allowMultipleIncomingCalls)
      || this.cs.incomingInvites.size
      >= C.NUMBER_OF_SIMULTANEOUS_INCOMING_CALLS_ALLOWED
    ) {
      Plivo.log.debug(`${C.LOGCAT.CALL} | Already on call, Sending busy call due to existing call, invite-size: ${this.cs.incomingInvites.size} }`);
      this.cs.loggerUtil.setSipCallID("");
      const opts = {
        status_code: 486,
        reason_phrase: 'Busy Here',
      };
      evt.session.terminate(opts);
      return false;
    }
    return true;
  };
}

export default Account;
