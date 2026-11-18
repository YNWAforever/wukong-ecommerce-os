import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "@wukong/db";

import { createPilotLeadPostHandler } from "./route";

const database = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
const emailPrefix = `pilot-route-${randomUUID()}`;
const octets = randomBytes(3);
const ip = `10.${octets[0]}.${octets[1]}.${octets[2]}`;

beforeAll(async () => {
  await database.migrate();
});

afterAll(async () => {
  await admin`delete from pilot_leads where email like ${`${emailPrefix}%`}`;
  await database.close();
  await admin.end();
});

function request(email: string, forwardedFor = ip) {
  return new Request("https://app.example/api/pilot-leads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      "user-agent": "Vitest integration",
    },
    body: JSON.stringify({
      name: "Ada Merchant",
      email,
      company: "Synthetic Cellar",
      platforms: ["shopline"],
      skuVolume: "100_500",
      message: "Synthetic pilot request.",
      consent: true,
    }),
  });
}

describe("POST /api/pilot-leads with Postgres", () => {
  const handler = createPilotLeadPostHandler({
    store: database,
    ipSalt: "integration-salt",
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  });

  it("persists three accepted leads and rejects the fourth by email or IP", async () => {
    const email = `${emailPrefix}@example.test`;
    for (let index = 0; index < 3; index++) {
      const response = await handler(request(email));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ ok: true });
    }

    const limited = await handler(request(email));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("600");

    const otherEmail = await handler(
      request(`${emailPrefix}-second@example.test`),
    );
    expect(otherEmail.status).toBe(429);

    const rows = await admin<
      Array<{
        email: string;
        consent_at: Date;
        platforms: string[];
        sku_volume: string;
        locale: string;
        source: string;
        request_ip_hash: string;
        user_agent: string;
      }>
    >`select email, consent_at, platforms, sku_volume, locale, source,
             request_ip_hash, user_agent
        from pilot_leads where email = ${email} order by created_at`;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      email,
      platforms: ["shopline"],
      sku_volume: "100_500",
      locale: "en",
      source: "marketing",
      user_agent: "Vitest integration",
      request_ip_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(rows[0]?.consent_at.toISOString()).toBe("2026-11-18T12:00:00.000Z");
  });
});
