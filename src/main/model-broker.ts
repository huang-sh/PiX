const optionNames = [
  "temperature",
  "samplingParams",
  "maxTokens",
  "reasoning",
  "cacheRetention",
  "sessionId",
  "transport",
  "thinkingBudgets",
  "maxRetryDelayMs",
  "timeoutMs",
  "maxRetries",
  "serviceTier",
] as const;

export function brokerOptions(input: unknown) {
  const source = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  return Object.fromEntries(
    optionNames.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name]]],
    ),
  );
}

export function brokerEvent(event: any) {
  switch (event?.type) {
    case "start":
      return { type: event.type };
    case "text_start":
    case "thinking_start":
      return { type: event.type, contentIndex: event.contentIndex };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end":
    case "thinking_end":
      return { type: event.type, contentIndex: event.contentIndex, content: event.content };
    case "toolcall_start": {
      const tool = event.partial?.content?.[event.contentIndex];
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        id: tool?.id,
        name: tool?.name,
      };
    }
    case "toolcall_end":
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        toolCall: event.toolCall,
      };
    case "done":
      return { type: event.type, reason: event.reason, message: event.message };
    case "error":
      return { type: event.type, reason: event.reason, error: event.error };
    default:
      throw new Error("Unsupported model stream event");
  }
}

export class BrokerModelStream implements AsyncIterable<any> {
  private readonly queue: any[] = [];
  private readonly waiting: Array<(value: IteratorResult<any>) => void> = [];
  private ended = false;
  private readonly partial: any;
  private readonly resultPromise: Promise<any>;
  private resolveResult!: (value: any) => void;

  constructor(model: any) {
    this.partial = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.resultPromise = new Promise((accept) => (this.resolveResult = accept));
  }

  push(wire: any) {
    if (this.ended) return;
    const event = this.inflate(wire);
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
    if (wire.type === "done" || wire.type === "error") {
      this.ended = true;
      this.resolveResult(wire.type === "done" ? event.message : event.error);
      while (this.waiting.length) this.waiting.shift()!({ value: undefined, done: true });
    }
  }

  fail(message: string) {
    this.push({
      type: "error",
      reason: "error",
      error: { ...this.partial, stopReason: "error", errorMessage: message },
    });
  }

  private inflate(wire: any) {
    const index = Number(wire.contentIndex);
    switch (wire.type) {
      case "start":
        return { type: wire.type, partial: this.partial };
      case "text_start":
        this.partial.content[index] = { type: "text", text: "" };
        return { type: wire.type, contentIndex: index, partial: this.partial };
      case "text_delta":
        this.partial.content[index].text += String(wire.delta ?? "");
        return { type: wire.type, contentIndex: index, delta: wire.delta, partial: this.partial };
      case "text_end":
        this.partial.content[index].text = String(wire.content ?? "");
        return { type: wire.type, contentIndex: index, content: wire.content, partial: this.partial };
      case "thinking_start":
        this.partial.content[index] = { type: "thinking", thinking: "" };
        return { type: wire.type, contentIndex: index, partial: this.partial };
      case "thinking_delta":
        this.partial.content[index].thinking += String(wire.delta ?? "");
        return { type: wire.type, contentIndex: index, delta: wire.delta, partial: this.partial };
      case "thinking_end":
        this.partial.content[index].thinking = String(wire.content ?? "");
        return { type: wire.type, contentIndex: index, content: wire.content, partial: this.partial };
      case "toolcall_start":
        this.partial.content[index] = {
          type: "toolCall",
          id: String(wire.id ?? ""),
          name: String(wire.name ?? ""),
          arguments: {},
          partialJson: "",
        };
        return { type: wire.type, contentIndex: index, partial: this.partial };
      case "toolcall_delta":
        this.partial.content[index].partialJson += String(wire.delta ?? "");
        return { type: wire.type, contentIndex: index, delta: wire.delta, partial: this.partial };
      case "toolcall_end":
        this.partial.content[index] = wire.toolCall;
        return { type: wire.type, contentIndex: index, toolCall: wire.toolCall, partial: this.partial };
      case "done":
        Object.assign(this.partial, wire.message);
        return { type: wire.type, reason: wire.reason, message: this.partial };
      case "error":
        Object.assign(this.partial, wire.error);
        return { type: wire.type, reason: wire.reason, error: this.partial };
      default:
        throw new Error("Invalid broker model event");
    }
  }

  result() {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<any> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((accept) => this.waiting.push(accept));
      },
    };
  }
}
