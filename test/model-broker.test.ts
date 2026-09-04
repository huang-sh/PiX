import test from "node:test";
import assert from "node:assert/strict";
import {
  brokerEvent,
  brokerOptions,
  BrokerModelStream,
} from "../src/main/model-broker.js";

test("model broker drops remote authentication and transport overrides", () => {
  assert.deepEqual(
    brokerOptions({
      maxTokens: 123,
      reasoning: "low",
      apiKey: "must-not-cross",
      headers: { authorization: "must-not-cross" },
      env: { SECRET: "must-not-cross" },
      fetch: "must-not-cross",
    }),
    { maxTokens: 123, reasoning: "low" },
  );
});

test("model broker rebuilds a streamed assistant response", async () => {
  const model = { api: "test", provider: "test", id: "test-model" };
  const stream = new BrokerModelStream(model);
  const source = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  };
  stream.push(brokerEvent({ type: "start", partial: source }));
  stream.push(brokerEvent({ type: "text_start", contentIndex: 0, partial: source }));
  stream.push(brokerEvent({ type: "text_delta", contentIndex: 0, delta: "hello", partial: source }));
  stream.push(brokerEvent({ type: "text_end", contentIndex: 0, content: "hello", partial: source }));
  stream.push(brokerEvent({ type: "done", reason: "stop", message: source }));

  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.equal((await stream.result()).content[0].text, "hello");
});
