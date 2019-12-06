import { interpolateNumber } from 'd3-interpolate'
import { scaleLinear } from 'd3-scale'
import { min, max } from 'd3-array'

import Observe from '../utils/Observe'
import { average } from '../utils/array'

export interface LooperOptions {
  volumeSmoothing?: number
  volumeAverage?: number
  staticIntervalBaseDuration?: number
}

export interface Tempo {
  start: number
  duration: number
  confidence: number
}

export interface LooperHooks {
  tatum: ((tatum: Tempo) => void)[]
  segment: ((segment: Tempo) => void)[]
  beat: ((beat: Tempo) => void)[]
  bar: ((bar: Tempo) => void)[]
  section: ((section: Tempo) => void)[]
}

/**
 * @class Looper
 *
 * Creates an interface for analyzing a playing Spotify track in real time.
 * Exposes event hooks for reacting to changes in intervals.
 */
export default class Looper {
  private state: any
  private hooks: LooperHooks = {
    tatum: [],
    segment: [],
    beat: [],
    bar: [],
    section: []
  }

  constructor({
    volumeSmoothing = 100,
    volumeAverage = 200,
    staticIntervalBaseDuration = 2000
  }: LooperOptions = {}) {
    this.state = Observe({
      intervalTypes: ['tatums', 'segments', 'beats', 'bars', 'sections'],
      activeIntervals: Observe({
        tatums: {},
        segments: {},
        beats: {},
        bars: {},
        sections: {}
      }),
      currentlyPlaying: {},
      trackAnalysis: {},
      trackFeatures: {},
      initialTrackProgress: 0,
      initialStart: 0,
      trackProgress: 0,
      active: false,
      initialized: false,
      noPlayback: false,
      loadingNextSong: false,
      volumeSmoothing,
      volumeAverage,
      volume: 0,
      queues: {
        volume: [],
        beat: []
      },
      volumeQueues: {}
    })

    this.subscribeHooks()

    this.state.trackAnalysis = this.buildStaticIntervals(staticIntervalBaseDuration)
    this.state.trackFeatures = {
      danceability: 0.5,
      energy: 0.5,
      key: 9,
      loudness: -10,
      mode: 1,
      speechiness: 0.1,
      acousticness: 0.1,
      instrumentalness: 0.5,
      liveness: 0.1,
      valence: 0.5,
      tempo: 100.03
    }
    this.state.active = true
    requestAnimationFrame(this.tick.bind(this))
  }

  /**
   * @method initHooks - Initialize interval event hooks.
   */
  subscribeHooks() {
    this.state.intervalTypes.forEach((t: string) => {
      this.state.activeIntervals.watch(t, (v: Tempo) => {
        this.hooks.segment.forEach(h => h(v))
      })
    })
  }

  /**
   * @method setActiveIntervals - Use current track progress to determine active intervals of each type.
   */
  setActiveIntervals() {
    const determineInterval = (type: string) => {
      const analysis = this.state.trackAnalysis[type]
      const progress = this.state.trackProgress
      for (let i = 0; i < analysis.length; i++) {
        if (i === analysis.length - 1) return i
        if (analysis[i].start < progress && progress < analysis[i + 1].start) return i
      }
    }

    this.state.intervalTypes.forEach((type: string) => {
      const index = determineInterval(type)!
      if (index !== this.state.activeIntervals[type].index) {
        this.state.activeIntervals[type] = { ...this.state.trackAnalysis[type][index], index }
      }

      const { start, duration } = this.state.activeIntervals[type]
      const elapsed = this.state.trackProgress - start
      this.state.activeIntervals[type].elapsed = elapsed
      this.state.activeIntervals[type].progress = elapsed / duration
    })
  }

  /**
   * @method getVolume - Extract volume data from active segment.
   */
  getVolume(interval = this.state.activeIntervals.segments) {
    const {
      loudness_max,
      loudness_start,
      loudness_max_time,
      duration,
      elapsed,
      start,
      index
    } = interval

    if (!this.state.trackAnalysis.segments[index + 1]) return 0

    const next = this.state.trackAnalysis.segments[index + 1].loudness_start
    const current = start + elapsed

    if (elapsed < loudness_max_time) {
      const progress = Math.max(Math.min(1, elapsed / loudness_max_time), 0)
      return interpolateNumber(loudness_start, loudness_max)(progress)
    } else {
      const _start = start + loudness_max_time
      const _elapsed = current - _start
      const _duration = duration - loudness_max_time
      const progress = Math.max(Math.min(1, _elapsed / _duration), 0)
      return interpolateNumber(loudness_max, next)(progress)
    }
  }

  /**
   * @method watch - Convenience method for watching data store.
   * @param {string} key
   * @param {function} method
   */
  watch(key: string, method: (t: Tempo) => void) {
    this.state.watch(key, method)
  }

  /**
   * @method on - Convenience method for applying interval hooks.
   * @param {string} - Interval type.
   * @param {function} - Event handler.
   */
  on(interval: keyof LooperHooks, method: (t: Tempo) => void) {
    this.hooks[interval].push(method)
  }

  /**
   * @getter isActive - Returns if class is actively syncing with a playing track.
   */
  get isActive() {
    return this.state.active === true
  }

  get tatum() {
    return this.state.activeIntervals.tatums
  }

  get segment() {
    return this.state.activeIntervals.segments
  }

  get beat() {
    return this.state.activeIntervals.beats
  }

  get bar() {
    return this.state.activeIntervals.bars
  }

  get section() {
    return this.state.activeIntervals.sections
  }

  /**
   * @method getInterval - Convenience method for retreiving active interval of type.
   * @param {string} type - Interval type, e.g. `beat` or `tatum`
   */
  getInterval(type: string) {
    return this.state.activeIntervals[type + 's']
  }

  /**
   * @method registerVolumeQueue - Register a volume analysis stream.
   */
  registerQueue({
    name,
    totalSamples,
    smoothing,
    mode = 'average'
  }: {
    name: string
    totalSamples: any
    smoothing: any
    mode: string
  }) {
    this.state.volumeQueues[name] = {
      totalSamples,
      smoothing,
      values: [0, 1],
      volume: 0.5,
      average: 0.5,
      min: 0,
      max: 1,
      mode
    }
  }

  processVolumeQueues() {
    const volume = this.getVolume()

    for (let key in this.state.volumeQueues) {
      const queue = this.state.volumeQueues[key]
      queue.values.unshift(volume)
      while (queue.values.length > queue.totalSamples) {
        queue.values.pop()
      }
      queue.average = average(queue.values)
      queue.min = min(queue.values)
      queue.max = max(queue.values)

      const sizeScale = scaleLinear().domain([
        queue.min,
        queue.mode === 'average' ? queue.average : queue.max
      ])

      const latest = average(queue.values.slice(0, queue.smoothing))
      queue.volume = sizeScale(latest)
    }
  }

  getVolumeQueue(name: string) {
    return this.state.volumeQueues[name].volume
  }

  resetVolumeQueues() {
    for (let key in this.state.volumeQueues) {
      const queue = this.state.volumeQueues[key]
      queue.volume = 0.5
      queue.average = 0.5
      queue.min = 0
      queue.max = 1
      queue.values = [0, 1]
    }
  }

  /**
   * @method tick - A single update tick from the Sync loop.
   * @param {DOMHighResTimeStamp} now
   */
  tick(now: number) {
    requestAnimationFrame(this.tick.bind(this))
    this.state.trackProgress = now - this.state.initialStart + this.state.initialTrackProgress
    this.setActiveIntervals()
    this.processVolumeQueues()
  }

  buildStaticIntervals(base: number) {
    const analysis = {}
    const duration = {
      beats: base,
      tatums: [base * (2 / 3), base * (1 / 3)],
      segments: base / 2,
      sections: base * 16,
      bars: base * 4
    }

    const types: string[] = ['tatums', 'segments', 'beats', 'bars', 'sections']

    types.forEach(type => {
      ;(analysis as any)[type] = []

      for (var i = 0; i < 10000; i++) {
        const tatumStart = (analysis as any).tatums[i - 1]
          ? Math.round(
              (analysis as any).tatums[i - 1].start + (analysis as any).tatums[i - 1].duration
            )
          : 0

        const tatumDuration =
          i % 2 === 0 ? Math.round(duration.tatums[0]) : Math.round(duration.tatums[1])
        ;(analysis as any)[type].push({
          start: type === 'tatums' ? tatumStart : i * (analysis as any)[type],
          duration: type === 'tatums' ? tatumDuration : (duration as any)[type],
          loudness_start: -30 + (i / 10000) * 20,
          loudness_max: -25 + (i / 10000) * 20,
          loudness_max_time: 0.5 * (duration as any)[type]
        })
      }
    })

    return analysis
  }
}
