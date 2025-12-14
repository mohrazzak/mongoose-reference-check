import { Schema, Document, Types, Query } from "mongoose";
import type {
  ReferenceCheckOptions,
  RefField,
  ValidationResult,
  RefModel,
} from "./types";

export type {
  ReferenceCheckOptions,
  RefField,
  ValidationResult,
  RefModel,
} from "./types";

function ReferenceCheck<T extends Document>(
  schema: Schema<T>,
  options: ReferenceCheckOptions = {}
): void {
  // Default configuration
  const config: Required<ReferenceCheckOptions> = {
    enableSave: true,
    enableUpdate: true,
    enableDelete: true,
    enableLogging: false,
    batchSize: 100,
    ...options,
  };

  // Helper function to get reference fields from schema
  function getRefFields(schema: Schema): RefField[] {
    const refFields: RefField[] = [];

    for (const field in schema.paths) {
      const path = schema.paths[field];

      // Handle direct reference
      if (path.options.ref) {
        refFields.push({
          field,
          refTo: path.options.ref as string,
        });
      }

      // Handle array of references (simple array like [ObjectId])
      if (path instanceof Schema.Types.Array && path.schema) {
        for (const subField in path.schema.paths) {
          const subPath = path.schema.paths[subField];
          if (subPath.options.ref) {
            refFields.push({
              field,
              refTo: subPath.options.ref as string,
            });
          }
        }
      }

      // Handle first-level nested objects with ObjectId references
      // For fields like "item.deviceId" where item is an object
      if (field.includes(".")) {
        const parts = field.split(".");
        // Only handle first-level nesting (e.g., item.deviceId)
        if (parts.length === 2 && path.options.ref) {
          refFields.push({
            field,
            refTo: path.options.ref as string,
          });
        }
      }
    }

    return refFields;
  }

  // Helper function to extract values from nested structures
  function extractNestedValue(
    data: any,
    fieldPath: string
  ): Types.ObjectId | Types.ObjectId[] | undefined {
    if (!fieldPath.includes(".")) {
      return data[fieldPath];
    }

    const parts = fieldPath.split(".");

    // Handle array of objects with nested field (e.g., "p.a" where p is an array)
    if (parts.length === 2) {
      const [parentField, childField] = parts;
      const parentValue = data[parentField];

      if (!parentValue) return undefined;

      // If parent is an array of objects, extract all child values
      if (Array.isArray(parentValue)) {
        const values = parentValue
          .map((item) => item?.[childField])
          .filter((val) => val !== undefined && val !== null);
        return values.length > 0 ? values : undefined;
      }

      // If parent is a single object, get the child value
      if (typeof parentValue === "object" && parentValue !== null) {
        return parentValue[childField];
      }
    }

    return undefined;
  }

  // Helper function to validate single reference
  async function validateReference(
    model: any,
    value: Types.ObjectId | Types.ObjectId[] | null | undefined,
    fieldName: string
  ): Promise<boolean> {
    try {
      if (!value) return true;

      // Handle array values
      if (Array.isArray(value)) {
        if (value.length === 0) return true;

        // Batch check for arrays
        const uniqueValues = [...new Set(value.map((v) => v.toString()))];
        const count = await model.countDocuments({
          _id: { $in: uniqueValues },
        });
        return count === uniqueValues.length;
      }

      // Single value check
      const exists = await model.exists({ _id: value });
      return exists !== null;
    } catch (error: any) {
      throw new Error(
        `Database error validating ${fieldName}: ${error.message}`
      );
    }
  }

  // Helper function to log operations
  function log(message: string): void {
    if (config.enableLogging) {
      console.log(`[ReferenceCheck] ${message}`);
    }
  }

  // Save middleware
  if (config.enableSave) {
    schema.pre<T>("save", async function (next) {
      try {
        const refFields = getRefFields(this.schema);
        if (refFields.length === 0) return next();

        log(`Validating ${refFields.length} reference fields on save`);

        for (const fieldObj of refFields) {
          let value: Types.ObjectId | Types.ObjectId[] | undefined;

          // Use extractNestedValue for both simple and nested fields
          if (fieldObj.field.includes(".")) {
            value = extractNestedValue(this.toObject(), fieldObj.field);
          } else {
            value = this.get(fieldObj.field) as
              | Types.ObjectId
              | Types.ObjectId[];
          }

          if (!value) continue;

          const model = this.model(fieldObj.refTo);
          const isValid = await validateReference(model, value, fieldObj.field);

          if (!isValid) {
            throw new Error(
              `Reference validation failed: The value ${value} does not exist within ${fieldObj.refTo}`
            );
          }
        }

        log("Save validation completed successfully");
        next();
      } catch (error: any) {
        next(error);
      }
    });
  }

  // Update middlewares
  if (config.enableUpdate) {
    const updateOperations: Array<
      "findOneAndUpdate" | "updateOne" | "updateMany"
    > = ["findOneAndUpdate", "updateOne", "updateMany"];

    schema.pre<Query<any, T>>(updateOperations, async function (next) {
      try {
        const payload = this.getUpdate() as Record<string, any>;
        if (!payload) return next();

        const refFields = getRefFields(this.model.schema);
        if (refFields.length === 0) return next();

        log(`Validating ${refFields.length} reference fields on update`);

        for (const fieldObj of refFields) {
          // Handle nested fields (e.g., "item.deviceId" or "p.a" where p is array)
          let value: Types.ObjectId | Types.ObjectId[] | undefined;

          if (fieldObj.field.includes(".")) {
            // First check dot-notation in payload (e.g., {"p.a": value})
            if (payload[fieldObj.field]) {
              value = payload[fieldObj.field];
            } else {
              // Then check nested structure (e.g., {p: [{a: value}]})
              value = extractNestedValue(payload, fieldObj.field);
            }
          } else {
            value = payload[fieldObj.field] as
              | Types.ObjectId
              | Types.ObjectId[];
          }

          if (!value) continue;

          const model = this.model.db.model(fieldObj.refTo);
          const isValid = await validateReference(model, value, fieldObj.field);

          if (!isValid) {
            throw new Error(
              `Reference validation failed: The value ${value} does not exist within ${fieldObj.refTo}`
            );
          }
        }

        log("Update validation completed successfully");
        next();
      } catch (error: any) {
        next(error);
      }
    });
  }

  // Delete middleware with performance optimization
  if (config.enableDelete) {
    const deleteOperations: Array<
      "deleteOne" | "findOneAndDelete" | "deleteMany"
    > = ["deleteOne", "findOneAndDelete", "deleteMany"];

    schema.pre<Query<any, T>>(deleteOperations, async function (next) {
      try {
        const deletingModelName = this.model.modelName;
        const query = this.getQuery();

        log(`Checking references before deleting from ${deletingModelName}`);

        // Get the item being deleted
        const deletingItem = await this.model.findOne(query);
        if (!deletingItem) {
          log("No item found to delete, skipping reference check");
          return next();
        }

        // Find all models that reference this model
        const refModels: RefModel[] = [];
        const allModelNames = this.model.db.modelNames();

        for (const modelName of allModelNames) {
          if (modelName === deletingModelName) continue;

          const model = this.model.db.model(modelName);
          const refFields: string[] = [];

          for (const field in model.schema.paths) {
            const path = model.schema.paths[field];
            if (path.options.ref === deletingModelName) {
              refFields.push(field);
            }
          }

          if (refFields.length > 0) {
            refModels.push({
              modelName,
              fields: refFields,
            });
          }
        }

        if (refModels.length === 0) {
          log("No references found, safe to delete");
          return next();
        }

        // Check references using optimized queries
        for (const refModel of refModels) {
          const model = this.model.db.model(refModel.modelName);

          // Build match conditions for both direct and nested fields
          const matchConditions = refModel.fields.map((field) => {
            // For nested fields like "item.deviceId", use dot notation in MongoDB query
            return { [field]: deletingItem._id };
          });

          // Use aggregation for better performance
          const pipeline = [
            {
              $match: {
                $or: matchConditions,
              },
            },
            { $limit: 1 },
          ];

          const exists = await model.aggregate(pipeline);

          if (exists.length > 0) {
            throw new Error(
              `Cannot delete record ${deletingItem._id}: It is referenced in ${refModel.modelName} model`
            );
          }
        }

        log("Delete validation completed successfully");
        next();
      } catch (error: any) {
        next(error);
      }
    });
  }

  // Add utility methods to schema
  schema.statics.validateReferences = async function (
    this: any,
    data: Record<string, any>
  ): Promise<ValidationResult[]> {
    const refFields = getRefFields(this.schema);
    const results: ValidationResult[] = [];

    for (const fieldObj of refFields) {
      let value: Types.ObjectId | Types.ObjectId[] | undefined;

      if (fieldObj.field.includes(".")) {
        value = extractNestedValue(data, fieldObj.field);
      } else {
        value = data[fieldObj.field] as Types.ObjectId | Types.ObjectId[];
      }

      if (!value) continue;

      const model = this.model(fieldObj.refTo);
      const isValid = await validateReference(model, value, fieldObj.field);

      results.push({
        field: fieldObj.field,
        refTo: fieldObj.refTo,
        value,
        isValid,
      });
    }

    return results;
  };

  // Add instance method to check references
  schema.methods.checkReferences = async function (
    this: T
  ): Promise<ValidationResult[]> {
    const refFields = getRefFields(this.schema);
    const results: ValidationResult[] = [];

    for (const fieldObj of refFields) {
      let value: Types.ObjectId | Types.ObjectId[] | undefined;

      if (fieldObj.field.includes(".")) {
        value = extractNestedValue(this.toObject(), fieldObj.field);
      } else {
        value = this.get(fieldObj.field) as Types.ObjectId | Types.ObjectId[];
      }

      if (!value) continue;

      const model = this.model(fieldObj.refTo);
      const isValid = await validateReference(model, value, fieldObj.field);

      results.push({
        field: fieldObj.field,
        refTo: fieldObj.refTo,
        value,
        isValid,
      });
    }

    return results;
  };
}

export default ReferenceCheck;
