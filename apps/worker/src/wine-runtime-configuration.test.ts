import { expect, it } from "vitest";
import { wineRuntimeConfiguration } from "./wine-runtime-configuration.js";
const config = {
  S3_BUCKET: "fixture",
  S3_ENDPOINT: "https://s3.test",
  S3_ACCESS_KEY_ID: "synthetic",
  S3_SECRET_ACCESS_KEY: "synthetic",
  TAVILY_API_KEY: "synthetic",
  WEBSITE_FETCH_BASE_URL: "https://callback.test",
  QUEUE_INGRESS_SECRET: "synthetic",
};
it("full readiness requires immutable HTTPS storage and authenticated document acquisition independently", () => {
  expect(wineRuntimeConfiguration(config as never)).toEqual({
    storageConfigured: true,
    documentConfigured: true,
    fullResearchConfigured: true,
  });
  expect(
    wineRuntimeConfiguration({
      ...config,
      S3_SECRET_ACCESS_KEY: undefined,
    } as never),
  ).toEqual({
    storageConfigured: false,
    documentConfigured: true,
    fullResearchConfigured: false,
  });
  expect(
    wineRuntimeConfiguration({
      ...config,
      WEBSITE_FETCH_BASE_URL: "http://callback.test",
    } as never),
  ).toEqual({
    storageConfigured: true,
    documentConfigured: false,
    fullResearchConfigured: false,
  });
  expect(wineRuntimeConfiguration({} as never).fullResearchConfigured).toBe(
    false,
  );
});
