/**
 * Tests for the raw-artifact document scanner: the parity guarantee that lets
 * the boot build skip chunk-row unpacking, plus its skip and failure rules.
 */
import { describe, expect, it } from 'vitest'
import { eventSearchText, scanRawArtifact, scannedDocOf } from '../src/doc-scan.ts'

/** Serialize records as one JSONL artifact, header line first. */
function artifact(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

const header = { type: 'session', version: 1, id: 's1', createdAt: 1, delegationDepth: 0 }

const userMessage = (seq: number, text: string) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { content: [{ type: 'text', text }] },
})

const assistantMessage = (seq: number, text: string) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: { message: { content: [{ type: 'text', text }] } },
})

describe('scanRawArtifact', () => {
  it('extracts user and assistant text in log order', () => {
    const text = artifact([header, userMessage(1, 'hello host'), assistantMessage(2, 'hello client')])
    expect(scanRawArtifact(text)).toEqual([
      { seq: 1, time: 1001, text: 'hello host' },
      { seq: 2, time: 1002, text: 'hello client' },
    ])
  })

  it('skips the session header line', () => {
    expect(scanRawArtifact(artifact([header]))).toEqual([])
  })

  it('skips packed chunk-storage rows in their real on-disk shape', () => {
    // Real ChunkRow shape (dsh-session/chunk-rows): bare slash-less type tag,
    // seq0/time0 anchors, and payload texts[] — never seq/time/content. Only
    // 'assistant/chunk' runs are ever packed, so a message row is always a
    // verbatim line; these rows must contribute nothing.
    const textRun = { type: 'text-chunks', seq0: 5, time0: 1005, data: { turn: 1, step: 1, index: 0, dt: [2, 3], texts: ['strea', 'ming', ' text'] } }
    const reasoningRun = { type: 'reasoning-chunks', seq0: 9, time0: 1009, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['think', 'ing'] } }
    const toolRun = { type: 'tool-call-chunks', seq0: 12, time0: 1012, data: { turn: 1, step: 1, index: 0, dt: [1], id: 'call-1', name: 'bash', args: ['{"a"', ':1}'] } }
    const docs = scanRawArtifact(artifact([header, textRun, reasoningRun, toolRun, assistantMessage(20, 'streaming text')]))
    expect(docs).toEqual([{ seq: 20, time: 1020, text: 'streaming text' }])
  })

  it('rejects a chunk-tagged row even when its payload mimics a message', () => {
    // Adversarial: this pins the RECORD-TYPE filter specifically. The row is
    // shaped exactly like an assistant message (seq/time/data.message.content)
    // but tagged as a storage row, so only the type check can reject it. If a
    // future harness packs message rows, this is the test that must be
    // revisited alongside the rawScan escape hatch.
    const disguised = {
      type: 'text-chunks',
      seq: 5,
      time: 1005,
      data: { message: { content: [{ type: 'text', text: 'must not be indexed' }] } },
    }
    expect(scanRawArtifact(artifact([header, disguised]))).toEqual([])
    expect(scannedDocOf(disguised)).toBeUndefined()
  })

  it('skips tool and bookkeeping records', () => {
    const records = [
      header,
      { type: 'tool/call', seq: 1, time: 1001, data: { name: 'bash', args: { command: 'grep needle' } } },
      { type: 'tool/result', seq: 2, time: 1002, data: { content: [{ type: 'text', text: 'needle found' }] } },
      { type: 'todo/write', seq: 3, time: 1003, data: { todos: [{ content: 'needle task', status: 'pending' }] } },
      { type: 'turn/end', seq: 4, time: 1004, data: {} },
    ]
    expect(scanRawArtifact(artifact(records))).toEqual([])
  })

  it('survives an unparseable line without losing the rest', () => {
    const text = [
      JSON.stringify(header),
      '{"type":"user/message","seq":1,',
      JSON.stringify(userMessage(2, 'after the tear')),
      '',
    ].join('\n')
    expect(scanRawArtifact(text)).toEqual([{ seq: 2, time: 1002, text: 'after the tear' }])
  })

  it('tolerates a missing trailing newline and blank lines', () => {
    const text = JSON.stringify(header) + '\n\n' + JSON.stringify(userMessage(1, 'no trailing newline'))
    expect(scanRawArtifact(text)).toEqual([{ seq: 1, time: 1001, text: 'no trailing newline' }])
  })

  it('drops a message row missing seq or time', () => {
    const noSeq = { type: 'user/message', time: 5, data: { content: [{ type: 'text', text: 'x' }] } }
    const noTime = { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'x' }] } }
    expect(scanRawArtifact(artifact([header, noSeq, noTime]))).toEqual([])
  })

  it('drops a message whose blocks carry no text', () => {
    const imageOnly = { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'image', source: 'x' }] } }
    const blank = { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: '   ' }] } }
    expect(scanRawArtifact(artifact([header, imageOnly, blank]))).toEqual([])
  })

  it('joins multiple text blocks the way the logical path does', () => {
    const multi = {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: { message: { content: [{ type: 'text', text: 'first' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'second' }] } },
    }
    expect(scanRawArtifact(artifact([header, multi]))).toEqual([{ seq: 1, time: 2, text: 'first\nsecond' }])
  })

  it('agrees with the logical path record for record', () => {
    // The boot build reads raw artifacts but the live feed reads logical
    // events; a divergence here would make cached and live documents differ.
    const records = [userMessage(1, 'alpha'), assistantMessage(2, 'beta'), { type: 'turn/end', seq: 3, time: 4, data: {} }]
    const viaRaw = scanRawArtifact(artifact([header, ...records]))
    const viaLogical = records.map((record) => scannedDocOf(record)).filter((doc) => doc !== undefined)
    expect(viaRaw).toEqual(viaLogical)
  })
})

describe('eventSearchText', () => {
  it('still reads both message shapes', () => {
    expect(eventSearchText(userMessage(1, 'prompt'))).toBe('prompt')
    expect(eventSearchText(assistantMessage(2, 'answer'))).toBe('answer')
  })

  it('rejects non-message events and non-objects', () => {
    expect(eventSearchText({ type: 'tool/call', data: {} })).toBeUndefined()
    expect(eventSearchText(null)).toBeUndefined()
    expect(eventSearchText('user/message')).toBeUndefined()
  })
})
