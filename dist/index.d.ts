import { Schema, Document } from "mongoose";
import type { ReferenceCheckOptions } from "./types";
export type { ReferenceCheckOptions, RefField, ValidationResult, RefModel, } from "./types";
declare function ReferenceCheck<T extends Document>(schema: Schema<T>, options?: ReferenceCheckOptions): void;
export default ReferenceCheck;
//# sourceMappingURL=index.d.ts.map