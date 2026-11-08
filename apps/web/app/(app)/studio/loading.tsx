import { RouteLoading } from "../../../components/route-loading";

/**
 * `/studio` route loading state.
 *
 * Delegates to the shared locale-aware loading component: a loading boundary
 * may render before the Studio shell's copy bundle is available, so it must
 * not duplicate strings that ignore the reader's language choice.
 */
export default function StudioLoading() {
  return <RouteLoading />;
}
