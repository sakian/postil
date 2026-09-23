/**
 * Who receives an event. The UI gets everything. Claude's session gets only events that
 * need it to act: every frame it receives becomes a turn in its context, so file-change
 * noise from its own edits must never reach it.
 */
export type Channel = 'ui' | 'agent';

export interface PostilEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: PostilEvent, channels: readonly Channel[]) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  emit(event: PostilEvent, channels: readonly Channel[] = ['ui']): void {
    for (const listener of this.listeners) {
      try {
        listener(event, channels);
      } catch (e) {
        console.error('postil: event listener failed', e);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
