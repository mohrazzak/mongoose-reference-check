import { Types } from "mongoose";

export interface ReferenceCheckOptions {
  enableSave?: boolean;
  enableUpdate?: boolean;
  enableDelete?: boolean;
  enableLogging?: boolean;
  batchSize?: number;
  orgScopedField?: string;
}

export interface RefField {
  field: string;
  refTo: string;
  refCheckFilter?: Record<string, any>;
}

export interface ValidationResult {
  field: string;
  refTo: string;
  value: Types.ObjectId | Types.ObjectId[] | null;
  isValid: boolean;
}

export interface RefModel {
  modelName: string;
  fields: string[];
}

declare module "mongoose" {
  interface Document {
    checkReferences(): Promise<ValidationResult[]>;
  }
}
