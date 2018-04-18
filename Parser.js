const Loader = require('./Loader')
const TmSetting = require('./Setting')
const { TrackParser } = require('./TrackParser')
const TmError = require('./Error')
const EPSILON = 0.0000000001

class Parser {
  /**
   * Tm Parser
   * @param {data} tokenizedData 经过tok的JSON对象
   * @example
   * new Parser(tokenizedData)
   */
  constructor(data) {
    this.Sections = data.Sections
    this.libraries = new Loader(data.Syntax)
    this.result = {
      Sections: undefined
    }
    this.sectionContext = {
      Settings: new TmSetting(),
      PrevFin: undefined
    }
    this.order = []
  }

  parse() {
    const result = []
    this.expandSection()
    this.generateOrder()
    this.Sections.forEach((part) => {
      if (part.Type === 'Section') {
        result.push(this.parseSection(part))
      } else {
        this.libraries.Package.applyFunction({
          Settings: this.sectionContext.Settings, Context: {}
        }, part)
      }
    })
    return result.filter(sect => sect.Tracks.length > 0)
  }

  expandSection() {
    const result = []
    for (const section of this.Sections) {
      result.push(...section.Prolog, section, ...section.Epilog)
      delete section.Prolog
      delete section.Epilog
      section.Type = 'Section'
    }
    this.Sections = result
  }

  generateOrder() {
    const secs = this.Sections
    this.Sections = [] // 一会儿展开后还存这里面
    const length = secs.length
    let pointer = 0
    let repeatBeginIndex = [] // 用数组存储嵌套反复每次开始的位置
    let segnoIndex = null
    let order = [] // 嵌套反复每次反复的次数
    let volta = [] // 存储当前小房子反复跳跃记号对应的反复次数
    let skip = false // 是否是大反复的第二次反复
    while (pointer < length) {
      const element = secs[pointer]
      switch (element.Type) {
      case 'RepeatBegin':
        repeatBeginIndex.push(pointer)
        order.push(1)
        break
      case 'RepeatEnd':
        if (order.length === 0) { // 无反复开始记号，即为从头反复
          repeatBeginIndex.push(-1)
          order.push(1)
        }
        if (volta.length > 0) { // 当前在小房子里
          if (volta.indexOf(order[order.length - 1] + 1) === -1 && (secs[pointer + 1].Type !== 'Volta' || secs[pointer + 1].Order.indexOf(order[order.length - 1] + 1) === -1)) { // 判断是否还有下一次反复，没有则终止反复
            repeatBeginIndex.pop()
            order.pop()
          } else { // 还有下一次反复
            order[order.length - 1]++
            pointer = repeatBeginIndex[repeatBeginIndex.length - 1]
            volta = []
          }
        } else { // 没有小房子，则反复两次
          if (order[order.length - 1] === 1) {
            order[order.length - 1]++
            pointer = repeatBeginIndex[repeatBeginIndex.length - 1]
          } else {
            repeatBeginIndex.pop()
            order.pop()
          }
        }
        break
      case 'Volta':
        if (element.Order.indexOf(order[order.length - 1]) === -1) { // 反复跳跃记号不是当前反复次数
          let pointer1 = pointer + 1
          let nest = 1
          while (pointer1 < length && nest > 0) { // 寻找匹配的反复结束记号
            switch (secs[pointer1].Type) {
            case 'RepeatBegin':
              nest++
              break
            case 'RepeatEnd':
              nest--
              break
            case 'Volta':
              // 对于带反复跳跃记号的反复中又含带反复跳跃记号的反复的情况，会引起严重的歧义，并导致错误匹配 RepeatEnd，最好能报错阻止
              break
            }
            pointer1++
          }
          if (nest === 0) {
            pointer = pointer1 - 1 // 指向匹配的反复结束记号
          } else {
            // 报个错
          }
        } else {
          volta = element.Order
        }
        break
      case 'Segno':
        if (segnoIndex == null) {
          segnoIndex = pointer
        } else if (segnoIndex !== pointer) {
          // 报个错
        }
        break
      case 'Coda':
        if (skip) {
          pointer++
          while (pointer < length && secs[pointer].Type !== 'Coda') {
            pointer++
          }
          if (pointer === length) {
            // 报个错
          }
        }
        break
      case 'DaCapo':
        if (!skip) {
          skip = true
          pointer = -1
        }
        break
      case 'DaSegno':
        if (!skip) {
          if (segnoIndex == null) {
            // 报个错
          } else {
            skip = true
            pointer = segnoIndex
          }
        }
        break
      case 'Fine':
        return
      case 'Section':
      case 'Function':
        this.Sections.push(element)
        break
      }
      pointer += 1
    }
  }

  /**
     * parse section
     * @param {Tm.Section} section
     */
  parseSection(section) {
    const settings = this.sectionContext.Settings.extend()
    for (const setting of section.Settings) {
      setting.Spec.filter((token) => token.Type === 'Function')
        .forEach((token) => this.libraries.Package.applyFunction({ Settings: settings, Context: {} }, token))
    }
    const instrStatistic = {}
    const sec = {
      Tracks: [].concat(...section.Tracks.map((track) => {
        if (track.Name !== undefined) {
          this.libraries.Track[track.Name] = track.Content
        }
        if (track.Play) {
          const tempTracks = []
          if (track.Instruments.length === 0) {
            track.Instruments.push({
              Name: 'Piano',
              Spec: []
            })
          }
          for (const instr of track.Instruments) {
            tempTracks.push(new TrackParser(track, instr, settings, this.libraries).parseTrack())
          }
          for (const tempTrack of tempTracks) {
            if (tempTrack.Instrument in instrStatistic) {
              instrStatistic[tempTrack.Instrument] += 1
            } else {
              instrStatistic[tempTrack.Instrument] = 1
            }
            if (track.ID === '') {
              tempTrack.ID += '#' + instrStatistic[tempTrack.Instrument].toString()
            }
          }
          return tempTracks
        } else {
          return []
        }
      })),
      Warnings: []
    }
    const max = Math.max(...sec.Tracks.map((track) => track.Meta.Duration))
    if (!sec.Tracks.every((track) => Math.abs(track.Meta.Duration - max) < EPSILON)) {
      sec.Warnings.push(new TmError(TmError.Types.Section.DiffDuration, [], { Expected: sec.Tracks.map(() => max), Actual: sec.Tracks.map((l) => l.Meta.Duration) }))
    }
    const maxBarIni = Math.max(...sec.Tracks.map((track) => track.Meta.BarFirst))
    const maxBarFin = Math.max(...sec.Tracks.map((track) => track.Meta.BarLast))
    const ini = sec.Tracks.every((track) => track.Meta.BarFirst === maxBarIni)
    const fin = sec.Tracks.every((track) => track.Meta.BarLast === maxBarFin)
    if (!ini) {
      sec.Warnings.push(new TmError(TmError.Types.Section.InitiativeBar, [], { Expected: maxBarIni, Actual: sec.Tracks.map((l) => l.Meta.BarFirst) }))
    }
    if (!fin && !Number.isNaN(maxBarFin)) {
      sec.Warnings.push(new TmError(TmError.Types.Section.FinalBar, [], { Expected: maxBarFin, Actual: sec.Tracks.map((l) => l.Meta.BarLast) }))
    }
    if (fin && this.sectionContext.PrevFin === undefined) {
      this.sectionContext.PrevFin = maxBarFin
    } else if (fin && ini && maxBarIni !== settings.Bar && this.sectionContext.PrevFin + maxBarIni !== settings.Bar) {
      const expected = settings.Bar - this.sectionContext.PrevFin
      sec.Warnings.push(new TmError(TmError.Types.Section.Mismatch, [], { Expected: expected, Actual: sec.Tracks.map((l) => l.Meta.BarFirst) }))
      this.sectionContext.PrevFin = maxBarFin
    }
    return sec
  }
}

module.exports = Parser