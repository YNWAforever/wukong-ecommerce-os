import {
  createProductShotHandler,
  productShotRouteDeps,
  type ProductShotRouteDeps,
} from "../route";
export const runtime = "nodejs";
export const createApproveProductShotHandler = (deps: ProductShotRouteDeps) =>
  createProductShotHandler(deps, "approve");
export const POST = createApproveProductShotHandler(productShotRouteDeps);
