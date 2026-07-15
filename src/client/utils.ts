import type { GenericActionCtx, GenericDataModel } from "convex/server";

// Pick from the action ctx: in convex 1.42 the query/mutation ctx variants
// gained an options param, so only the action signatures fit every ctx kind.
export type QueryCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
