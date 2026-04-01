import type { Comment, CommentReply } from '../formats/provenance-sidecar';
import type { AgentResponse } from './types';

export interface TriggerEvent {
  type: 'comment' | 'inline';
  mentionText: string;
  position?: { from: number; to: number };
  commentId?: string;
  commentThread?: Comment[];
  timestamp: number;
}

export interface TriggerServiceCallbacks {
  onTrigger?: (event: TriggerEvent) => void;
  onAgentStart?: (_task: unknown) => void;
  onAgentComplete?: (_task: unknown, _response: AgentResponse) => void | Promise<void>;
  onError?: (error: Error, task?: unknown) => void;
}

const MENTION_PATTERN = /@agentdoc\b/i;

export class TriggerService {
  private callbacks: TriggerServiceCallbacks = {};
  private documentContent = '';

  setCallbacks(callbacks: TriggerServiceCallbacks): void {
    this.callbacks = callbacks;
  }

  updateDocumentContent(content: string): void {
    this.documentContent = content;
  }

  setCurrentUser(_user: string): void {
    // OSS default: embedded agent loop is disabled.
  }

  hasMention(text: string): boolean {
    return MENTION_PATTERN.test(text);
  }

  extractMentions(text: string): { index: number; match: string }[] {
    const mentions: { index: number; match: string }[] = [];
    const pattern = new RegExp(MENTION_PATTERN.source, 'gi');
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (typeof match.index === 'number') {
        mentions.push({ index: match.index, match: match[0] });
      }
    }
    return mentions;
  }

  handleComment(_comment: Comment, _thread: Comment[]): void {}

  handleReply(_comment: Comment, _reply: CommentReply, _thread: Comment[]): void {}

  handleFreeformPrompt(prompt: string): void {
    this.callbacks.onTrigger?.({
      type: 'inline',
      mentionText: prompt,
      timestamp: Date.now(),
    });
  }

  handleAlwaysOnComment(_comment: Comment, _thread: Comment[]): void {}

  handleInlineMention(
    _position: { from: number; to: number },
    _surroundingText: string,
    _fullText: string,
  ): void {}

  getDocumentContent(): string {
    return this.documentContent;
  }
}

const triggerService = new TriggerService();

export function getTriggerService(): TriggerService {
  return triggerService;
}
