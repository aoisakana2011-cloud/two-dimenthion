export type PrimitiveType = 'int' | 'str';
export type ValueType = PrimitiveType | 'none' | { kind: 'dict'; value: PrimitiveType } | { kind: 'struct'; name: string };
export type DeclaredType = ValueType | 'infer';
export type AssetKind = 'bg' | 'char' | 'bgm' | 'se' | 'voice' | 'video' | 'image';

export interface NodeLocation {
  line?: number;
  column?: number;
  endLine?: number;
  file?: string;
}

export type Expr = NodeLocation & (
  | { kind: 'literal'; value: number | string | bigint }
  | { kind: 'variable'; name: string }
  | { kind: 'index'; target: Expr; key: Expr }
  | { kind: 'binary'; operator: string; left: Expr; right: Expr }
  | { kind: 'unary'; operator: string; value: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'dict'; entries: Array<{ key: string; value: Expr }> }
);

export interface Condition extends NodeLocation { kind: 'condition'; expression: Expr; }
export type Assignable = NodeLocation & (
  | { kind: 'variable'; name: string }
  | { kind: 'index'; target: Expr; key: Expr }
);

export type Statement = NodeLocation & (
  | { kind: 'declare'; type: DeclaredType; name: string; initial?: Expr; inferred?: boolean; constant?: boolean }
  | { kind: 'set'; target: Assignable; value: Expr }
  | { kind: 'unset'; target: Assignable }
  | { kind: 'command'; name: string; args: Expr[] }
  | { kind: 'sayBlock'; speaker: Expr; lines: Expr[] }
  | { kind: 'if'; condition: Condition; body: Statement[]; elseIf: Array<{ condition: Condition; body: Statement[] }>; otherwise: Statement[] }
  | { kind: 'for'; name: string; start: Expr; stop: Expr; step: Expr; body: Statement[] }
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
export interface StructDef extends NodeLocation { kind: 'struct'; name: string; fields: Record<string, PrimitiveType>; }
export interface FunctionDef extends NodeLocation { kind: 'function'; name: string; returnType: ValueType; params: Array<{ type: ValueType; name: string }>; body: Statement[]; }
export interface Scene extends NodeLocation { kind: 'scene'; name: string; body: Statement[]; }
export interface Script extends NodeLocation { kind: 'script'; assets: Asset[]; characters: Character[]; structs: StructDef[]; globals: Statement[]; functions: FunctionDef[]; scenes: Scene[]; includes: string[]; body: Statement[]; }

export type TokenType = 'word' | 'string' | 'number' | 'symbol' | 'newline' | 'eof';
export type Token = { type: TokenType; value: string; line: number; column: number; offset: number };
