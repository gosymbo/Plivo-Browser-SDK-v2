// eslint-disable-next-line import/no-cycle
import { Logger } from "../logger";
import * as C from "../constants";

const Plivo = {
  log: Logger,
};

/**
 * Initializes the RNNoise audio worklet and creates the filter node.
 *
 * @returns {Promise<AudioWorkletNode | undefined>}
 */
function initializeKRnnoise(
  audioContext: AudioContext,
  noiseReductionFilePath: string,
  retryCount: number,
)
  : Promise<AudioWorkletNode | undefined> {
  return new Promise((resolve) => {
    try {
      Plivo.log.debug(`${C.LOGCAT.LOGIN} | Noise suppresion file path is: ${noiseReductionFilePath}`);
      audioContext.audioWorklet.addModule(noiseReductionFilePath || "https://cdn.plivo.com/sdk/browser/processor.js").then(() => {
        Plivo.log.debug(`${C.LOGCAT.CALL_QUALITY} | audioWorklet setup is completed`);
        resolve(new AudioWorkletNode(audioContext, 'NoiseSuppressorWorklet-ts'));
      }).catch((err) => {
        Plivo.log.debug(`${C.LOGCAT.LOGIN} | Error while loading audio worklet: ${err} `);
        if (noiseReductionFilePath && retryCount === 0) {
          Plivo.log.debug(`${C.LOGCAT.LOGIN} | Could not add file from path: ${noiseReductionFilePath}. Fetching the file from plivo cdn`);
          resolve(initializeKRnnoise(audioContext, "https://cdn.plivo.com/sdk/browser/processor.js", 1));
        }
      });
    } catch (e) {
      Plivo.log.error(`${C.LOGCAT.CALL_QUALITY} | Error while initializing noise suppression effect ${e}`);
      resolve(undefined);
    }
  });
}

/**
 * Class Implementing the effect expected by a NoiseSupression.
 * Effect applies rnnoise denoising on a audio localTrack.
 */
export class NoiseSuppressionEffect {
  /**
   * Source that will be attached to the track affected by the effect.
   */
  private audioSource: MediaStreamAudioSourceNode | undefined;

  /**
   * Destination that will contain denoised audio from the audio worklet.
   */
  private audioDestination: MediaStreamAudioDestinationNode | undefined;

  /**
   * `AudioWorkletProcessor` associated node.
   */
  public noiseSuppressorNode?: AudioWorkletNode;

  /**
   * Audio track extracted from the original MediaStream to which the effect is applied.
   */
  private originalMediaTrack: MediaStreamTrack | undefined;

  /**
   * Noise suppressed audio track extracted from the media destination node.
   */
  private outputMediaTrack: MediaStreamTrack | undefined;

  private init: any;

  private audioContext: AudioContext;

  prepareAudioWorklet = function (noiseReductionFilePath: string)
    : Promise<AudioWorkletNode | undefined> {
    return new Promise((resolve) => {
      const initRnnoise = () => {
        initializeKRnnoise(this.audioContext, noiseReductionFilePath, 0).then((node) => {
          if (node) {
            this.noiseSuppressorNode = node;
            resolve(this.noiseSuppressorNode);
          } else {
            resolve(undefined);
          }
        });
      };

      if (!this.audioContext) {
        Plivo.log.debug(`${C.LOGCAT.CALL_QUALITY} | Creating new instance of AudioContext`);
        this.audioContext = new AudioContext();
        initRnnoise();
      } else {
        Plivo.log.debug(`${C.LOGCAT.CALL_QUALITY} | AudioContext instance already created. Resuming it.`);
        this.audioContext.resume().then(() => {
          initRnnoise();
        });
      }
    });
  };

  /**
   * Effect interface called by source NoiseSuppresion.
   * Applies effect that uses a {@code NoiseSuppressor} service
   * initialized with {@code RnnoiseProcessor}
   * for denoising.
   *
   * @param {MediaStream} audioStream - Audio stream which will be mixed with _mixAudio.
   * @returns {MediaStream} - MediaStream containing both audio tracks mixed together.
   */
  startEffect(audioStream: MediaStream): Promise<MediaStream> {
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line prefer-destructuring
        this.audioContext.resume().then(() => {
          // eslint-disable-next-line prefer-destructuring
          this.originalMediaTrack = audioStream.getAudioTracks()[0];
          this.audioSource = this.audioContext.createMediaStreamSource(audioStream);
          this.audioDestination = this.audioContext.createMediaStreamDestination();
          // eslint-disable-next-line prefer-destructuring
          this.outputMediaTrack = this.audioDestination.stream.getAudioTracks()[0];

          if (this.noiseSuppressorNode && this.audioSource && this.audioDestination) {
            this.audioSource.connect(this.noiseSuppressorNode);
            this.noiseSuppressorNode.connect(this.audioDestination);
          }

          // Sync the effect track muted state with the original track state.
          this.outputMediaTrack.enabled = this.originalMediaTrack.enabled;

          // // We enable the audio on the original track because
          // mute/unmute action will only affect the audio destination
          // // output track from this point on.
          this.originalMediaTrack.enabled = true;

          resolve(this.audioDestination.stream);
        });
      } catch (e) {
        Plivo.log.error(`${C.LOGCAT.CALL_QUALITY} | Error while starting noise suppression effect ${e}`);
        resolve(audioStream);
      }
    });
  }

  /**
   * Clean up resources acquired by noise suppressor and rnnoise processor.
   *
   * @returns {void}
   */
  stopEffect(): void {
    try {
      if (this.originalMediaTrack && this.outputMediaTrack) {
        this.originalMediaTrack.enabled = this.outputMediaTrack.enabled;
      }

      this.audioDestination?.disconnect();
      this.audioSource?.disconnect();
    } catch (e) {
      Plivo.log.error(`${C.LOGCAT.CALL_QUALITY} | Error while stopping noise suppression effect ${e}`);
    }
  }

  muteEffect(): void {
    try {
      if (this.noiseSuppressorNode && this.audioSource && this.audioDestination) {
        this.audioSource.disconnect(this.noiseSuppressorNode);
        this.noiseSuppressorNode.disconnect(this.audioDestination);
      }
    } catch (e) {
      Plivo.log.error(`${C.LOGCAT.CALL_QUALITY} | Error while mute in noise suppression effect ${e}`);
    }
  }

  unmuteEffect(): void {
    try {
      if (this.noiseSuppressorNode && this.audioSource && this.audioDestination) {
        this.audioSource.connect(this.noiseSuppressorNode);
        this.noiseSuppressorNode.connect(this.audioDestination);
      }
    } catch (e) {
      Plivo.log.error(`${C.LOGCAT.CALL_QUALITY} | Error while unmute in noise suppression effect ${e}`);
    }
  }

  clearEffect(): void {
    try {
      if (this.originalMediaTrack && this.outputMediaTrack) {
        // Sync original track muted state with effect state before removing the effect.
        this.originalMediaTrack.enabled = this.outputMediaTrack.enabled;
      }

      this.noiseSuppressorNode?.port?.close();

      this.audioDestination?.disconnect();
      this.noiseSuppressorNode?.disconnect();
      this.audioSource?.disconnect();
      this.audioContext.suspend();
    } catch (e) {
      Plivo.log.error(`${C.LOGCAT.CALL_QUALITY} | Error while clearing noise suppression effect ${e}`);
    }
  }
}

export function getBaseUrl(w: typeof window = window) {
  const doc = w.document;
  const base = doc.querySelector('base');

  if (base?.href) {
    return base.href;
  }

  const { protocol, host } = w.location;

  return `${protocol}//${host}`;
}
