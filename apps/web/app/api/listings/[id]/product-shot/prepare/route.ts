import {
  createProductShotHandler,
  productShotRouteDeps,
  type ProductShotRouteDeps,
} from "../route";
export const runtime = "nodejs";
export const createPrepareProductShotHandler = (deps: ProductShotRouteDeps) =>
  createProductShotHandler(deps, "prepare");
export const POST = createPrepareProductShotHandler(productShotRouteDeps);
