/**
 * ddlforge - Zero-Downtime Remediation Engine types
 */

export interface NotNullColumnAdditionParams {
  table: string;
  column: string;
  type?: string;
  defaultValue?: string;
}

export interface UnvalidatedForeignKeyParams {
  table: string;
  constraintName?: string;
  column: string;
  foreignTable: string;
  foreignColumn: string;
}

export interface PrimaryKeyMissingUsingIndexParams {
  table: string;
  constraintName?: string;
  columns: string[] | string;
  indexName?: string;
}

export interface ColumnTypeRewriteParams {
  table: string;
  column: string;
  oldType?: string;
  newType: string;
  shadowColumn?: string;
  triggerName?: string;
  functionName?: string;
}

export interface RemediationPhase {
  phase: number;
  title: string;
  description: string;
  sql: string;
  transactional: boolean;
}

export interface RemediationRecipe {
  ruleId: string;
  title: string;
  phases: RemediationPhase[];
  fullSql: string;
}
