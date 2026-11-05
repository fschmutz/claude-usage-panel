import { expect, test } from 'claude-code/testing'

import { enginePrefixWidth, hintPills, modelName } from '../hooks/footer.js'

test('the engine mode label is reserved only while a mode is on', () => {
  expect(enginePrefixWidth('? for shortcuts', 'auto')).toBe(0)
  expect(enginePrefixWidth('(shift+tab to cycle) · ← 5 agents', 'auto')).toBe('⏵⏵ auto mode on'.length + 3)
  expect(enginePrefixWidth('(shift+tab to cycle)', null)).toBe('⏵⏵ bypass permissions on'.length + 3)
  expect(enginePrefixWidth('(shift+tab to cycle)', 'default')).toBe(0)
})

test('the hint becomes pills and keeps what it does not know', () => {
  const texts = hintPills('(shift+tab to cycle) · ← 6 agents · esc to interrupt · ctrl+t to hide tasks').map(p =>
    p.map(r => r.text).join(''),
  )
  expect(texts).toEqual(['6 agents ←', 'esc to interrupt', 'ctrl+t to hide tasks'])
})

test('model ids read as names', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1[1m]')).toBe('Fable 5.1 1M')
  expect(modelName('custom-model')).toBe('custom-model')
})
