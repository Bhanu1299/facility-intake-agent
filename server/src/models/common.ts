import type { SchemaOptions } from 'mongoose';

/**
 * All collections use readable string ids (e.g. "elmwood-walkin-cooler") so test cases, logs and
 * the eval can reference them. JSON output renames _id to id and drops the version key.
 */
export function baseOptions<T>(collection: string): SchemaOptions<T> {
  return {
    collection,
    versionKey: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  };
}
