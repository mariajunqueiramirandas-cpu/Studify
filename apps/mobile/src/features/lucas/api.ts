// Ensine o Lucas client (INT-02; api §4.8): start (or resume) a lesson, stream Lucas's replies, finish.
import type { TeachingFinishRes, TeachingStartRes } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { callFunction, streamFunction } from '../../api/functions';
import { toEventHandler, type StreamHandlers } from '../learn/api';

export type LessonLength = 'short' | 'full';

export function startLesson(nodeId: string, length: LessonLength) {
  return callFunction<{ node_id: string; length: LessonLength }, TeachingStartRes>('teaching-start', { node_id: nodeId, length }, { idempotencyKey: uuidv7() });
}

export function sendToLucas(sessionId: string, message: string, inputMode: 'voice' | 'text', handlers: StreamHandlers) {
  return streamFunction('teaching-turn', { session_id: sessionId, message, input_mode: inputMode }, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

export function finishLesson(sessionId: string) {
  return callFunction<{ session_id: string }, TeachingFinishRes>('teaching-finish', { session_id: sessionId }, { idempotencyKey: uuidv7() });
}
