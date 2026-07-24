import test from 'node:test'
import assert from 'node:assert/strict'
import { projectHydrationDecision } from './projectIsolation.js'

test('a new empty session clears another project from persisted local state', () => {
  assert.equal(projectHydrationDecision({
    sessionId: 'factory',
    activeSessionId: 'driller',
    backendProject: null,
    localState: { selectedStory: { title: 'The Driller' }, images: { old: {} } },
  }), 'clear-local')
})

test('opening a saved project fully loads its own core instead of merging another project', () => {
  assert.equal(projectHydrationDecision({
    sessionId: 'factory',
    activeSessionId: 'driller',
    backendProject: { story: { title: 'The Factory' }, scenes: [{ scene_number: 1 }] },
    localState: { selectedStory: { title: 'The Driller' }, scenes: [{ scene_number: 1 }] },
  }), 'load-backend')
})

test('same-project reload may merge durable assets only', () => {
  assert.equal(projectHydrationDecision({
    sessionId: 'factory',
    activeSessionId: 'factory',
    backendProject: { story: { title: 'The Factory' } },
    localState: { selectedStory: { title: 'The Factory' } },
  }), 'merge-assets')
})

test('a conflicting story under the same session id reloads the backend project', () => {
  assert.equal(projectHydrationDecision({
    sessionId: 'shared-id',
    activeSessionId: 'shared-id',
    backendProject: { story: { title: 'The Driller' } },
    localState: { selectedStory: { title: 'The Factory' } },
  }), 'load-backend')
})
