import { createProductShotHandler, productShotRouteDeps } from "../route";

export const runtime = "nodejs";
export const POST = createProductShotHandler(productShotRouteDeps, "attach");
