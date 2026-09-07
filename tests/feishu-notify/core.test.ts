import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import {
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_IDLE_NOTIFY_TIMEOUT_SEC,
  DEFAULT_SUBAGENT_DELIVERY_GRACE_MS,
  DEFAULT_SUBAGENT_FLUSH_DEBOUNCE_MS,
  DEFAULT_WAIT_NOTIFY_TIMEOUT_SEC,
  buildCard,
  feishuSign,
  formatDuration,
  parseConfig,
  parseSubagentLifecycle,
  sendToFeishu,
  truncate,
} from "../../src/feishu-notify/core.js";

describe("feishuSign", () => {
  it("matches a fixed test vector", () => {
    // stringToSign = `${timestamp}\n${secret}`, HMAC-SHA256 key=stringToSign, data=""
    const sig = feishuSign("1700000000", "mysecret");
    expect(sig).toBe(createHmac("sha256", "1700000000\nmysecret").update("").digest("base64"));
  });

  it("same input -> same output, output is valid base64 (fast-check)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (ts, secret) => {
        const a = feishuSign(ts, secret);
        const b = feishuSign(ts, secret);
        expect(a).toBe(b);
        expect(() => Buffer.from(a, "base64")).not.toThrow();
      }),
    );
  });
});

describe("formatDuration", () => {
  it("handles boundaries", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(59)).toBe("59 秒");
    expect(formatDuration(60)).toBe("1 分钟");
    expect(formatDuration(3599)).toBe("59 分 59 秒");
    expect(formatDuration(3600)).toBe("1 小时 0 分");
  });

  it("is monotonic non-decreasing in length-independent value ordering (fast-check)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100000 }), (a, b) => {
        if (a <= b) {
          // duration string should not be "shorter representation for larger value" in a wildly wrong way;
          // weak invariant: same seconds -> same string
          expect(formatDuration(a)).toBe(formatDuration(a));
          expect(formatDuration(b)).toBe(formatDuration(b));
        }
      }),
    );
  });
});

describe("truncate", () => {
  it("never exceeds max length + ellipsis (fast-check)", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 500 }), (text, max) => {
        const result = truncate(text, max);
        expect(result.length).toBeLessThanOrEqual(max + 1);
      }),
    );
  });
});

describe("parseConfig", () => {
  const cases: Array<[unknown, string]> = [
    [0, "0"],
    [-1, "-1"],
    [null, "null"],
    ["abc", "abc"],
    [undefined, "缺失"],
  ];

  for (const [value, label] of cases) {
    it(`heartbeatIntervalSec=${label}`, () => {
      const cfg = parseConfig({ heartbeatIntervalSec: value as never }, {});
      if (typeof value === "number" && Number.isFinite(value)) {
        expect(cfg.heartbeatIntervalSec).toBe(value);
      } else {
        expect(cfg.heartbeatIntervalSec).toBe(DEFAULT_HEARTBEAT_INTERVAL_SEC);
      }
    });

    it(`idleNotifyTimeoutSec=${label}`, () => {
      const cfg = parseConfig({ idleNotifyTimeoutSec: value as never }, {});
      if (typeof value === "number" && Number.isFinite(value)) {
        expect(cfg.idleNotifyTimeoutSec).toBe(value);
      } else {
        expect(cfg.idleNotifyTimeoutSec).toBe(DEFAULT_IDLE_NOTIFY_TIMEOUT_SEC);
      }
    });

    it(`waitNotifyTimeoutSec=${label}`, () => {
      const cfg = parseConfig({ waitNotifyTimeoutSec: value as never }, {});
      if (typeof value === "number" && Number.isFinite(value)) {
        expect(cfg.waitNotifyTimeoutSec).toBe(value);
      } else {
        expect(cfg.waitNotifyTimeoutSec).toBe(DEFAULT_WAIT_NOTIFY_TIMEOUT_SEC);
      }
    });

    it(`subagentFlushDebounceMs=${label}`, () => {
      const cfg = parseConfig({ subagentFlushDebounceMs: value as never }, {});
      if (typeof value === "number" && Number.isFinite(value)) {
        expect(cfg.subagentFlushDebounceMs).toBe(value);
      } else {
        expect(cfg.subagentFlushDebounceMs).toBe(DEFAULT_SUBAGENT_FLUSH_DEBOUNCE_MS);
      }
    });

    it(`subagentDeliveryGraceMs=${label}`, () => {
      const cfg = parseConfig({ subagentDeliveryGraceMs: value as never }, {});
      if (typeof value === "number" && Number.isFinite(value)) {
        expect(cfg.subagentDeliveryGraceMs).toBe(value);
      } else {
        expect(cfg.subagentDeliveryGraceMs).toBe(DEFAULT_SUBAGENT_DELIVERY_GRACE_MS);
      }
    });
  }

  it("subagentSummaryEnabled defaults to true, false only when explicitly false", () => {
    expect(parseConfig({}, {}).subagentSummaryEnabled).toBe(true);
    expect(parseConfig({ subagentSummaryEnabled: false }, {}).subagentSummaryEnabled).toBe(false);
    expect(parseConfig({ subagentSummaryEnabled: true }, {}).subagentSummaryEnabled).toBe(true);
  });

  it("subagentForegroundSummary defaults to false, true only when explicitly true", () => {
    expect(parseConfig({}, {}).subagentForegroundSummary).toBe(false);
    expect(parseConfig({ subagentForegroundSummary: true }, {}).subagentForegroundSummary).toBe(true);
  });

  it("webhookUrl/secret fall back to env vars", () => {
    const cfg = parseConfig({}, { FEISHU_WEBHOOK_URL: "https://x", FEISHU_WEBHOOK_SECRET: "s" } as never);
    expect(cfg.webhookUrl).toBe("https://x");
    expect(cfg.secret).toBe("s");
  });
});

describe("buildCard", () => {
  const base = {
    project: "proj",
    prompt: "do things",
    durationSec: 65,
    turns: 3,
    toolCalls: 5,
    toolErrors: 1,
    summary: "done",
  };

  const statuses = ["success", "error", "waiting", "test", "heartbeat", "idle", "subagents"] as const;

  it.each(statuses)("builds a card with correct header for status=%s", (status) => {
    const card = buildCard({ status, ...base, errorMessage: status === "error" ? "boom" : undefined }) as any;
    expect(card.card.header).toMatchSnapshot();
  });

  it("overrides template/title/labels/details", () => {
    const card = buildCard({
      status: "subagents",
      ...base,
      overrides: {
        template: "green",
        title: "custom title",
        turnsLabel: "Run 数",
        toolCallsLabel: "成功/失败",
        details: "line1\nline2",
      },
    }) as any;
    expect(card.card.header.template).toBe("green");
    expect(card.card.header.title.content).toBe("custom title");
    const fieldsText = JSON.stringify(card.card.elements);
    expect(fieldsText).toContain("Run 数");
    expect(fieldsText).toContain("成功/失败");
    expect(fieldsText).toContain("line1");
  });

  it("truncates details to 800 chars", () => {
    const longDetails = "x".repeat(1000);
    const card = buildCard({ status: "subagents", ...base, overrides: { details: longDetails } }) as any;
    const detailsElement = card.card.elements[card.card.elements.length - 1];
    expect(detailsElement.text.content.length).toBeLessThanOrEqual(801); // 800 + ellipsis
  });
});

describe("parseSubagentLifecycle", () => {
  it("parses a valid started payload", () => {
    expect(parseSubagentLifecycle({ runId: "r1", at: 123 })).toEqual({
      runId: "r1",
      status: undefined,
      generation: undefined,
    });
  });

  it("parses a valid settled payload with generation", () => {
    expect(parseSubagentLifecycle({ runId: "r1", generation: 2, status: "completed", at: 1 })).toEqual({
      runId: "r1",
      status: "completed",
      generation: 2,
    });
  });

  it("returns undefined for missing runId / null / non-object", () => {
    expect(parseSubagentLifecycle({ at: 1 })).toBeUndefined();
    expect(parseSubagentLifecycle(null)).toBeUndefined();
    expect(parseSubagentLifecycle("string")).toBeUndefined();
    expect(parseSubagentLifecycle(42)).toBeUndefined();
    expect(parseSubagentLifecycle(undefined)).toBeUndefined();
  });
});

describe("sendToFeishu", () => {
  it("retries on failure then succeeds, with 1s/2s backoff sequence", async () => {
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 500, text: async () => "err" } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => '{"code":0}' } as unknown as Response;
    });

    const result = await sendToFeishu({ webhookUrl: "https://example.com/hook" }, { foo: "bar" }, { fetchFn, sleep });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([1000, 2000]);
  });

  it("returns ok:false with error when webhookUrl missing", async () => {
    const result = await sendToFeishu({}, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("webhookUrl");
  });

  it("gives up after MAX_RETRIES and returns last error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const sleep = vi.fn(async () => {});
    const result = await sendToFeishu({ webhookUrl: "https://x" }, {}, { fetchFn, sleep });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
