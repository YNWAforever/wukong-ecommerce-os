import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  turnReplySchema,
  type StudioTurnReply,
} from "../lib/studio/types";
import {
  parseStudioAssistantContent,
  parseStudioOperatorContent,
  StudioTurn,
  type StudioTurnMessage,
} from "./studio-turn";

function reply(overrides: Record<string, unknown> = {}): StudioTurnReply {
  return turnReplySchema.parse({
    status: "answered",
    skillKey: "catalog.find",
    skillVersion: "1.0.0",
    records: {
      sections: [
        {
          key: "studio.answer.heading",
          values: { skill: "catalog.find", skillVersion: "1.0.0" },
        },
        {
          key: "studio.answer.catalog_found",
          values: { count: 2, truncated: false },
        },
      ],
      checks: [
        {
          key: "studio.check.listing_status",
          values: {
            listingId: "listing-1",
            status: "approved",
            activeVersion: "present",
          },
          state: "ok",
        },
      ],
      coverage: { listing: "present", quality: "missing" },
    },
    outputs: [],
    analysis: null,
    traceSummary: { stepCount: 2 },
    limitations: [{ key: "studio.limit.exports_not_read", values: {} }],
    followUps: [{ key: "studio.followup.explain_status", values: {} }],
    ...overrides,
  });
}

function assistantMessage(content: Record<string, unknown>): StudioTurnMessage {
  return {
    messageId: "message-1",
    role: "assistant",
    content,
    createdAt: "2026-11-08T00:00:00.000Z",
    runId: "run-1",
  };
}

function renderAssistant(content: Record<string, unknown>, props = {}) {
  return renderToStaticMarkup(
    <StudioTurn
      locale="en"
      message={assistantMessage(content)}
      aiEnabled={false}
      trace={[]}
      {...props}
    />,
  );
}

describe("parseStudioAssistantContent", () => {
  it("accepts a valid persisted reply and rejects everything else", () => {
    expect(parseStudioAssistantContent(reply())).not.toBeNull();
    expect(
      parseStudioAssistantContent({ status: "answered", invented: true }),
    ).toBeNull();
    expect(parseStudioAssistantContent({})).toBeNull();
  });
});

describe("parseStudioOperatorContent", () => {
  it("parses text, locale and optional skill", () => {
    expect(
      parseStudioOperatorContent({
        text: "  hello  ",
        locale: "zh-Hant",
        skillKey: "catalog.find",
      }),
    ).toEqual({ text: "  hello  ", locale: "zh-Hant", skillKey: "catalog.find" });
    expect(parseStudioOperatorContent({ text: "" })).toBeNull();
    expect(parseStudioOperatorContent({ text: 3 })).toBeNull();
  });
});

describe("StudioTurn", () => {
  it("renders an operator turn with its text, skill chip and time", () => {
    const html = renderToStaticMarkup(
      <StudioTurn
        locale="en"
        message={{
          messageId: "operator-1",
          role: "operator",
          content: { text: "Find the Opak listings", locale: "en" },
          createdAt: "2026-11-08T00:00:00.000Z",
        }}
      />,
    );

    expect(html).toContain('data-role="operator"');
    expect(html).toContain("Find the Opak listings");
    expect(html).toContain("Your message");
  });

  it("shows an honest notice for invalid operator content", () => {
    const html = renderToStaticMarkup(
      <StudioTurn
        locale="en"
        message={{
          messageId: "operator-2",
          role: "operator",
          content: { notText: true },
          createdAt: "2026-11-08T00:00:00.000Z",
        }}
      />,
    );

    expect(html).toContain("This message could not be displayed.");
    expect(html).not.toContain("notText");
  });

  it("renders the records answer, checks, coverage, limitations, follow-ups and trace", () => {
    const html = renderAssistant(reply());

    expect(html).toContain('data-role="assistant"');
    expect(html).toContain("From your records");
    expect(html).toContain("Skill: catalog.find");
    expect(html).toContain("Found 2 matching listing records");
    expect(html).toContain("Listing listing-1: status approved");
    expect(html).toContain("Execution trace · 2 steps");
    expect(html).toContain("Known limitations");
    expect(html).toContain("does not read export records");
    expect(html).toContain("Follow-up questions");
    expect(html).toContain("Explain a listing&#x27;s current status");
    expect(html).toContain("Answered");
  });

  it("renders an invalid-content notice for unparseable assistant content without crashing", () => {
    const html = renderAssistant({ status: "answered", raw: "<script>" });

    expect(html).toContain("This reply could not be displayed; nothing is invented.");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("studio.answer");
  });

  it("shows the not-configured notice only when live analysis is disabled", () => {
    const disabled = renderAssistant(reply(), { aiEnabled: false });
    expect(disabled).toContain("Live analysis is not configured.");

    const maybeEnabled = renderAssistant(reply(), { aiEnabled: true });
    expect(maybeEnabled).not.toContain("Live analysis is not configured.");
  });

  it("separates a failed model attempt while the records answer stays", () => {
    const html = renderAssistant(
      reply({
        analysis: {
          sections: [],
          claims: [],
          limitations: [],
          followUps: [],
          configured: false,
          droppedClaims: 0,
        },
      }),
      { aiEnabled: true },
    );

    expect(html).toContain("AI suggestion · unverified");
    expect(html).toContain("Live analysis did not complete");
    expect(html).toContain("From your records");
    // The failure is stated as a failure, not as no analysis configured.
    expect(html).not.toContain("Live analysis is not configured.");
  });

  it("renders a configured analysis card with claims, refs and dropped-claim count", () => {
    const html = renderAssistant(
      reply({
        analysis: {
          sections: [{ heading: "Synthetic heading", body: "Synthetic body" }],
          claims: [
            { text: "Synthetic claim", evidenceRefs: ["listing:listing-1:v1"] },
          ],
          limitations: ["Synthetic model limitation"],
          followUps: [],
          configured: true,
          droppedClaims: 2,
        },
      }),
      { aiEnabled: true },
    );

    expect(html).toContain("AI suggestion · unverified");
    expect(html).toContain("Synthetic heading");
    expect(html).toContain("Synthetic claim");
    expect(html).toContain("Evidence: listing:listing-1:v1");
    expect(html).toContain("2 claims were dropped");
    expect(html).toContain("Synthetic model limitation");
    expect(html).toContain("no write authority");
  });

  it("renders nothing for a system/tool message rather than inventing a turn", () => {
    const html = renderToStaticMarkup(
      <StudioTurn
        locale="en"
        message={{
          messageId: "system-1",
          role: "system",
          content: {},
          createdAt: "2026-11-08T00:00:00.000Z",
        }}
        aiEnabled={true}
      />,
    );
    expect(html).toBe("");
  });
});
