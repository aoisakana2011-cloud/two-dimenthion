export type PrimitiveType = 'int' | 'float' | 'str' | 'bool';
export type ValueType = PrimitiveType | 'none' | { kind: 'dict'; value: PrimitiveType } | { kind: 'list'; value: PrimitiveType } | { kind: 'struct'; name: string };
export type DeclaredType = ValueType | 'infer';
export type AssetKind = 'bg' | 'char' | 'bgm' | 'se' | 'voice' | 'video' | 'image';

export interface NodeLocation {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  file?: string;
}

export type Expr = NodeLocation & (
  | { kind: 'literal'; value: number | string | bigint | boolean; sourceColumns?: number[] }
  | { kind: 'float'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'index'; target: Expr; key: Expr }
  | { kind: 'binary'; operator: string; left: Expr; right: Expr }
  | { kind: 'unary'; operator: string; value: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'dict'; entries: Array<{ key: string; value: Expr }> }
  | { kind: 'list'; items: Expr[] }
);

export interface Condition extends NodeLocation { kind: 'condition'; expression: Expr; }
export type Assignable = NodeLocation & (
  | { kind: 'variable'; name: string }
  | { kind: 'index'; target: Expr; key: Expr }
);

export type Statement = NodeLocation & (
  | { kind: 'declare'; type: DeclaredType; name: string; nameLine?: number; nameColumn?: number; initial?: Expr; inferred?: boolean; constant?: boolean; global?: boolean }
  | { kind: 'set'; target: Assignable; value: Expr }
  | { kind: 'unset'; target: Assignable }
  | { kind: 'command'; name: string; args: Expr[] }
  | { kind: 'if'; condition: Condition; body: Statement[]; elseIf: Array<{ condition: Condition; body: Statement[] }>; otherwise: Statement[] }
  | { kind: 'for'; name: string; nameLine?: number; nameColumn?: number; start: Expr; stop: Expr; step: Expr; body: Statement[] }
  | { kind: 'forEach'; name: string; nameLine?: number; nameColumn?: number; iterable: Expr; body: Statement[] }
  | { kind: 'while'; condition: Condition; body: Statement[] }
  | { kind: 'choice'; prompt?: Expr; options: Array<{ label: Expr; body: Statement[] }> }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'return'; value?: Expr }
  | { kind: 'goto'; scene: string }
);

export interface Asset extends NodeLocation { kind: 'asset'; type: AssetKind; name: string; path: string; }
export interface CharacterProperty extends NodeLocation { name: string; value: Expr; }
export interface Character extends NodeLocation {
  kind: 'character';
  name: string;
  properties: CharacterProperty[];
  poses: Array<{ name: string; path: string; line?: number; column?: number }>;
}
export interface ExternalCharacter { poses: Set<string>; fields: Record<string, PrimitiveType>; definition?: Character; }
export interface StructDef extends NodeLocation { kind: 'struct'; name: string; fields: Record<string, PrimitiveType>; fieldLocations?: Record<string, NodeLocation>; }
export interface FunctionDef extends NodeLocation { kind: 'function'; name: string; returnType: ValueType; params: Array<{ type: ValueType; name: string; line?: number; column?: number }>; body: Statement[]; }
export interface Scene extends NodeLocation { kind: 'scene'; name: string; body: Statement[]; }
export interface Include extends NodeLocation { path: string; alias: string; }
export interface Script extends NodeLocation { kind: 'script'; assets: Asset[]; characters: Character[]; structs: StructDef[]; globals: Statement[]; functions: FunctionDef[]; scenes: Scene[]; includes: Include[]; body: Statement[]; }

export type TokenType = 'word' | 'string' | 'number' | 'symbol' | 'newline' | 'eof';
export type Token = { type: TokenType; value: string; line: number; column: number; offset: number; unknownEscapes?: string[]; sourceColumns?: number[] };
