/* Shared tolerant lexer/CST formatter for the IDE and command-line tools. */
'use strict';

(function attachFormatter(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NovelFormatter = factory();
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const FORMAT_MARKER_PATTERN = /^\uE000NOVEL_EDITOR_(?:CURSOR|SELECTION_END)\uE001_*$/;
  const MULTI_SYMBOLS = new Set(['==', '!=', '>=', '<=', '->', '=>', '..']);
  const SYMBOLS = new Set('{}[]=():,+-*/%<>!.\\');
  const BLOCK_KEYWORDS = /^(?:scene|fn|if|elif|else|for|while|parallel|choice|character|struct)\b/;
  const COMMAND_KEYWORDS = /^(?:return|set|unset|say|show|hide|clear|bg|bgm|play|wait|effect|goto|include|global|const|int|str|dict)\b/;

  function trimFormatterSpace(value) { return value.replace(/^[ \t]+|[ \t]+$/g, ''); }

  function isWordStart(value) { return /[A-Za-z_]/.test(value || ''); }
  function isWordPart(value) { return /[A-Za-z0-9_]/.test(value || ''); }

  // Unlike the compiler lexer this lexer is deliberately tolerant: the user
  // may format an unterminated string, an incomplete call, or a half-written
  // block while typing. Every token carries its source range for CST splitting.
  function lex(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      const start = index;
      const char = source[index];
      if (char === ' ' || char === '\t') { index++; continue; }
      const marker = source.slice(index).match(/^\uE000NOVEL_EDITOR_(?:CURSOR|SELECTION_END)\uE001_*/);
      if (marker) {
        index += marker[0].length;
        tokens.push({ kind: 'marker', value: marker[0], start, end: index, embedded: start > 0 && index < source.length && !/[ \t]/.test(source[start - 1]) && !/[ \t]/.test(source[index]) });
        continue;
      }
      if (char === '#' || (char === '/' && source[index + 1] === '/')) {
        index = source.length;
        tokens.push({ kind: 'comment', value: source.slice(start), start, end: index });
        break;
      }
      if (char === '"') {
        index++;
        while (index < source.length) {
          if (source[index] === '\\') { index += Math.min(2, source.length - index); continue; }
          if (source[index++] === '"') break;
        }
        tokens.push({ kind: 'string', value: source.slice(start, index), start, end: index });
        continue;
      }
      // CLI-style modifiers are single DSL tokens. Keep them intact during
      // editor auto-fix just as the compiler lexer does; otherwise `--only`
      // is formatted as `- - only` and changes the command's meaning.
      const option = ['--only', '--layer'].find((value) => source.startsWith(value, index)
        && !isWordPart(source[index + value.length]));
      if (option) {
        index += option.length;
        tokens.push({ kind: 'word', value: option, start, end: index });
        continue;
      }
      const pair = source.slice(index, index + 2);
      if (MULTI_SYMBOLS.has(pair)) {
        index += 2;
        tokens.push({ kind: 'operator', value: pair, start, end: index });
        continue;
      }
      if (isWordStart(char)) {
        index++;
        while (isWordPart(source[index])) index++;
        tokens.push({ kind: 'word', value: source.slice(start, index), start, end: index });
        continue;
      }
      if (/[0-9]/.test(char)) {
        index += /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))[0].length;
        tokens.push({ kind: 'number', value: source.slice(start, index), start, end: index });
        continue;
      }
      if (SYMBOLS.has(char)) {
        index++;
        tokens.push({ kind: '=+-*/%<>!'.includes(char) ? 'operator' : 'punctuation', value: char, start, end: index });
        continue;
      }
      index++;
      tokens.push({ kind: 'plain', value: char, start, end: index });
    }
    return tokens;
  }

  function realTokenIndex(tokens, index) {
    let candidate = index - 1;
    while (candidate >= 0 && tokens[candidate].kind === 'marker') candidate--;
    return candidate;
  }

  function formatTokens(line) {
    const tokens = lex(line);
    const includeAs = tokens[0]?.kind === 'word' && tokens[0].value === 'include'
      ? tokens.findIndex((token, index) => index > 1 && token.kind === 'word' && token.value === 'as')
      : -1;
    const unary = tokens.map((token, index) => {
      const previousIndex = realTokenIndex(tokens, index);
      const previous = previousIndex >= 0 ? tokens[previousIndex] : undefined;
      return token.kind === 'operator' && ['+', '-', '!'].includes(token.value)
        && (previousIndex < 0 || previous?.kind === 'operator' || ['(', '[', '{', ',', ':'].includes(previous?.value)
          || (previous?.kind === 'word' && ['from', 'to', 'step', 'return'].includes(previous.value)));
    });
    let result = '';
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const previousIndex = realTokenIndex(tokens, index);
      const previous = previousIndex >= 0 ? tokens[previousIndex] : undefined;
      if (token.kind === 'marker') { result += token.value; continue; }
      if (token.kind === 'comment') { result += `${result ? '  ' : ''}${token.value}`; continue; }
      let spaced = previousIndex >= 0;
      // Unquoted include paths are a concatenation of adjacent lexer tokens.
      // Preserve those token boundaries exactly: inserting normal operator
      // spacing turns a valid path such as dir/module.tds into an invalid one.
      const embeddedMarker = tokens[index - 1]?.kind === 'marker' && tokens[index - 1].embedded;
      const markerJoinsToken = embeddedMarker && (
        (['word', 'number'].includes(previous?.kind) && ['word', 'number'].includes(token.kind))
        || (previous?.kind === 'operator' && token.kind === 'operator' && MULTI_SYMBOLS.has(`${previous.value}${token.value}`))
      );
      if (['[', ')', ']', ',', ':', '.'].includes(token.value) || ['(', '[', '.'].includes(previous?.value)) spaced = false;
      if (token.value === '(' && previous?.kind === 'word' && !['if', 'elif', 'while', 'not', 'return', 'choice'].includes(previous.value)) spaced = false;
      if (token.kind === 'operator') spaced = unary[index] ? !(previous?.kind === 'operator' || ['(', '[', '{', ',', ':'].includes(previous?.value)) : true;
      if (previous?.kind === 'operator') spaced = !unary[previousIndex];
      if (token.kind === 'operator' && unary[index] && previous?.kind === 'operator' && unary[previousIndex]) spaced = true;
      if (token.value === '}') spaced = previous?.value !== '{';
      if (previous?.value === '{') spaced = token.value !== '}';
      if (token.value === '{') spaced = index > 0 && !['(', '[', '{'].includes(previous?.value);
      if (previous?.value === ',' || previous?.value === ':') spaced = true;
      if (includeAs > 1 && index > 1 && index < includeAs) spaced = false;
      if (markerJoinsToken) spaced = false;
      result += `${spaced && result && !result.endsWith(' ') ? ' ' : ''}${token.value}`;
    }
    return { text: result.replace(/[ \t]+$/, ''), tokens: tokens.filter((token) => token.kind !== 'comment' && token.kind !== 'marker') };
  }

  function textBefore(raw, token) { return trimFormatterSpace(raw.slice(0, token.start)); }

  // Build only the CST information needed by formatting. Literal braces are
  // retained on the stack for correct matching but are never split into lines.
  function expandStructuralLine(raw, state) {
    const tokens = lex(raw);
    const structural = [];
    let previousBrace = -1;
    for (const token of tokens) {
      if (token.kind === 'comment' || token.kind === 'marker') continue;
      if (token.value === '(') { state.parenthesisDepth++; continue; }
      if (token.value === ')') { state.parenthesisDepth = Math.max(0, state.parenthesisDepth - 1); continue; }
      if (token.value === '[') { state.bracketDepth++; continue; }
      if (token.value === ']') { state.bracketDepth = Math.max(0, state.bracketDepth - 1); continue; }
      if (token.value === '{') {
        const before = textBefore(raw, token);
        const statementPrefix = trimFormatterSpace(raw.slice(previousBrace + 1, token.start));
        const headerPrefix = before;
        const keyword = /^(\w+)\b/.exec(statementPrefix)?.[1] || '';
        const dictionary = state.parenthesisDepth > 0 || state.bracketDepth > 0 || /(?:=|:|\[)[ \t]*$/.test(before);
        const statementCommand = COMMAND_KEYWORDS.test(statementPrefix);
        const parent = state.stack.at(-1);
        const choiceExpression = parent?.kind === 'choice' && !statementCommand && /^(?:"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_.]*(?:[ \t]*\([^{}]*\))?|\d+|[+-]|\(|!|not\b)/.test(statementPrefix);
        const block = !dictionary && (BLOCK_KEYWORDS.test(statementPrefix)
          || (previousBrace < 0 && BLOCK_KEYWORDS.test(headerPrefix))
          || /"[^"\\]*(?:\\.[^"\\]*)*"[ \t]*$/.test(statementPrefix)
          || choiceExpression);
        const node = { kind: block ? (choiceExpression ? 'choiceOption' : keyword) : 'literal', block, open: token };
        if (state.stack.length) state.stack.at(-1).children.push(node);
        state.stack.push({ ...node, children: [] });
        if (block) { structural.push({ index: token.start, type: 'open' }); previousBrace = token.start; }
      } else if (token.value === '}') {
        const entry = state.stack.pop();
        if (entry?.block) { structural.push({ index: token.start, type: 'close' }); previousBrace = token.start; }
      }
    }
    if (!structural.length) return [raw];
    const result = [];
    let cursor = 0;
    for (const brace of structural) {
      const before = trimFormatterSpace(raw.slice(cursor, brace.index));
      if (brace.type === 'open') {
        const opening = trimFormatterSpace(raw.slice(cursor, brace.index + 1));
        if (opening) result.push(opening);
        cursor = brace.index + 1;
      } else {
        if (before) result.push(before);
        result.push('}');
        cursor = brace.index + 1;
      }
    }
    const tail = trimFormatterSpace(raw.slice(cursor));
    if (tail) {
      const trailingComment = /^(?:#|\/\/)/.test(tail);
      if (trailingComment && result.length) result[result.length - 1] += `  ${tail}`;
      else result.push(tail);
    }
    return result;
  }

  function format(source) {
    const state = { stack: [], parenthesisDepth: 0, bracketDepth: 0 };
    const normalized = String(source).replace(/^\uFEFF/, '').replace(/\r\n?|\u2028|\u2029/g, '\n');
    const lines = normalized.split('\n').flatMap((raw) => {
      const expanded = expandStructuralLine(raw, state);
      return expanded.flatMap((line) => {
        const closingOnly = /^[ \t]*((?:}[ \t]*){2,})(#.*)?$/.exec(line);
        if (!closingOnly) return [line];
        const count = (closingOnly[1].match(/}/g) || []).length;
        return Array.from({ length: count }, (_, index) => `}${index === count - 1 && closingOnly[2] ? `  ${closingOnly[2]}` : ''}`);
      });
    });
    let indent = 0;
    const formattedLines = lines.map((raw) => {
      const trimmed = trimFormatterSpace(raw);
      if (!trimmed) return { text: '', canJoinBranch: false };
      const formatted = formatTokens(trimmed);
      const leadingClosers = formatted.tokens.findIndex((token) => token.value !== '}');
      const closeIndent = leadingClosers < 0 ? formatted.tokens.length : leadingClosers;
      const depthBeforeLine = indent;
      const lineIndent = Math.max(0, indent - closeIndent);
      const opens = formatted.tokens.filter((token) => token.value === '{').length;
      const closes = formatted.tokens.filter((token) => token.value === '}').length;
      indent = Math.max(0, indent + opens - closes);
      return {
        text: `${'  '.repeat(lineIndent)}${formatted.text}`,
        canJoinBranch: formatted.text === '}' && depthBeforeLine >= closeIndent,
      };
    });
    const joined = [];
    for (const formattedLine of formattedLines) {
      const line = formattedLine.text;
      if (/^[ \t]*(?:else|elif)\b/.test(line)) {
        let previous = joined.length - 1;
        while (previous >= 0 && !trimFormatterSpace(joined[previous].text)) previous--;
        if (previous >= 0 && joined[previous].canJoinBranch && trimFormatterSpace(joined[previous].text) === '}') {
          joined[previous].text += ` ${line.replace(/^[ \t]+/, '')}`;
          joined.splice(previous + 1);
          continue;
        }
      }
      joined.push(formattedLine);
    }
    return joined.map((line) => line.text).join('\n').replace(/[ \t]+$/gm, '');
  }

  return { format, lex };
}));
