/**
 * remark plugin + stringify handler for Agentdoc mark spans.
 *
 * Parses inline <span data-proof="...">...</span> HTML into mdast nodes
 * and serializes agentdocMark nodes back to HTML spans.
 */

type AgentdocMarkNode = {
  type: 'agentdocMark';
  markKind: string;
  attrs?: Record<string, string | null | undefined>;
  children?: Array<{ type: string; value?: string; children?: any[] }>;
};

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
};

type MdastParent = {
  children: MdastNode[];
};

function isAgentdocHtml(value: string): boolean {
  return value.includes('<span') && (value.includes('data-agentdoc') || value.includes('data-proof'));
}

function parseAttributes(input: string): Record<string, string> | null {
  const attrs: Record<string, string> = {};
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    let name = '';
    while (i < input.length && /[^\s=]/.test(input[i])) {
      name += input[i];
      i++;
    }
    if (!name) return null;

    while (i < input.length && /\s/.test(input[i])) i++;

    let value = '';
    if (input[i] === '=') {
      i++;
      while (i < input.length && /\s/.test(input[i])) i++;
      const quote = input[i];
      if (quote === '"' || quote === '\'') {
        i++;
        while (i < input.length && input[i] !== quote) {
          value += input[i];
          i++;
        }
        if (input[i] !== quote) return null;
        i++;
      } else {
        while (i < input.length && /[^\s]/.test(input[i])) {
          value += input[i];
          i++;
        }
      }
    }

    attrs[name] = value;
  }

  return attrs;
}

function parseAgentdocHtml(value: string): MdastNode[] | null {
  const root: MdastNode[] = [];
  const stack: AgentdocMarkNode[] = [];

  const pushNode = (node: MdastNode) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      root.push(node);
    }
  };

  let i = 0;
  while (i < value.length) {
    const nextLt = value.indexOf('<', i);
    if (nextLt === -1) {
      const text = value.slice(i);
      if (text) pushNode({ type: 'text', value: text });
      break;
    }

    if (nextLt > i) {
      const text = value.slice(i, nextLt);
      if (text) pushNode({ type: 'text', value: text });
      i = nextLt;
    }

    if (value.startsWith('</span', i)) {
      const end = value.indexOf('>', i);
      if (end === -1) return null;
      if (stack.length === 0) return null;
      stack.pop();
      i = end + 1;
      continue;
    }

    if (value.startsWith('<span', i)) {
      const end = value.indexOf('>', i);
      if (end === -1) return null;
      const attrSource = value.slice(i + 5, end).trim();
      const attrs = parseAttributes(attrSource);
      if (!attrs) return null;
      const markKind = attrs['data-agentdoc'] ?? attrs['data-proof'];
      if (!markKind) return null;
      const agentdocId = markKind === 'authored'
        ? (attrs['data-agentdoc-id'] ?? attrs['data-proof-id'] ?? attrs['data-id'])
        : attrs['data-id'];

      const agentdocNode: AgentdocMarkNode = {
        type: 'agentdocMark',
        markKind,
        attrs: {
          id: agentdocId,
          by: attrs['data-by'],
          kind: attrs['data-kind'],
        },
        children: [],
      };

      pushNode(agentdocNode as MdastNode);
      stack.push(agentdocNode);
      i = end + 1;
      continue;
    }

    // Handle <code>...</code> inside agentdoc spans (backwards compat)
    if (value.startsWith('<code>', i)) {
      const codeStart = i + 6;
      const codeEnd = value.indexOf('</code>', codeStart);
      if (codeEnd === -1) return null;
      pushNode({ type: 'inlineCode', value: value.slice(codeStart, codeEnd) });
      i = codeEnd + 7;
      continue;
    }

    // Handle <strong>...</strong>, <em>...</em>, <del>...</del>
    const htmlTagMatch = value.slice(i).match(/^<(strong|em|del)>/i);
    if (htmlTagMatch) {
      const tagName = htmlTagMatch[1].toLowerCase();
      const closeTag = `</${tagName}>`;
      const contentStart = i + htmlTagMatch[0].length;
      const closeIdx = value.indexOf(closeTag, contentStart);
      if (closeIdx === -1) return null;
      const inner = value.slice(contentStart, closeIdx);
      const mdastType = tagName === 'strong' ? 'strong' : tagName === 'em' ? 'emphasis' : 'delete';
      // Recursively parse inner content
      const innerParsed = parseAgentdocHtml(inner);
      pushNode({ type: mdastType, children: innerParsed ?? [{ type: 'text', value: inner }] });
      i = closeIdx + closeTag.length;
      continue;
    }

    return null;
  }

  if (stack.length > 0) return null;
  return root;
}

type AgentdocSpanToken =
  | { type: 'open'; markKind: string; attrs: Record<string, string | null | undefined> }
  | { type: 'close' };

function parseAgentdocSpanToken(value: string): AgentdocSpanToken | null {
  const trimmed = value.trim();
  if (/^<\/span\s*>$/i.test(trimmed)) {
    return { type: 'close' };
  }

  const openMatch = trimmed.match(/^<span\b([^>]*)>$/i);
  if (!openMatch) return null;

  const attrs = parseAttributes(openMatch[1].trim());
  if (!attrs) return null;
  const markKind = attrs['data-agentdoc'] ?? attrs['data-proof'];
  if (!markKind) return null;
  const agentdocId = markKind === 'authored'
    ? (attrs['data-agentdoc-id'] ?? attrs['data-proof-id'] ?? attrs['data-id'])
    : attrs['data-id'];

  return {
    type: 'open',
    markKind,
    attrs: {
      id: agentdocId,
      by: attrs['data-by'],
      kind: attrs['data-kind'],
    },
  };
}

function normalizeSplitAgentdocSpans(parent: MdastParent): void {
  const { children } = parent;
  const stack: AgentdocMarkNode[] = [];
  let i = 0;

  while (i < children.length) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string') {
      const token = parseAgentdocSpanToken(child.value);
      if (token?.type === 'open') {
        const agentdocNode: AgentdocMarkNode = {
          type: 'agentdocMark',
          markKind: token.markKind,
          attrs: token.attrs,
          children: [],
        };

        const current = stack[stack.length - 1];
        if (current) {
          current.children = current.children ?? [];
          current.children.push(agentdocNode as MdastNode);
          children.splice(i, 1);
        } else {
          children.splice(i, 1, agentdocNode as MdastNode);
          i += 1;
        }

        stack.push(agentdocNode);
        continue;
      }

      if (token?.type === 'close') {
        if (stack.length > 0) {
          stack.pop();
          children.splice(i, 1);
          continue;
        }
      }
    }

    if (stack.length > 0) {
      const current = stack[stack.length - 1];
      current.children = current.children ?? [];
      current.children.push(child);
      children.splice(i, 1);
      continue;
    }
    i += 1;
  }
}

/**
 * Post-process agentdocMark children to convert legacy HTML formatting nodes
 * (e.g. <code>...</code>, <strong>...</strong>) into proper mdast nodes.
 * This provides backwards compatibility with files serialized before the
 * markdown-output fix.
 */
function normalizeHtmlFormattingInAgentdocMarks(node: MdastNode): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === 'agentdocMark' && child.children) {
      child.children = convertHtmlFormatting(child.children);
      normalizeHtmlFormattingInAgentdocMarks(child);
    } else {
      normalizeHtmlFormattingInAgentdocMarks(child);
    }
  }
}

function convertHtmlFormatting(children: MdastNode[]): MdastNode[] {
  const result: MdastNode[] = [];
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string') {
      const tag = child.value.trim();

      // Match <code>, <strong>, <em>, <del>
      const openMatch = tag.match(/^<(code|strong|em|del)>$/i);
      if (openMatch) {
        const tagName = openMatch[1].toLowerCase();
        const closeTag = `</${tagName}>`;
        // Collect content until closing tag
        const inner: MdastNode[] = [];
        let j = i + 1;
        let found = false;
        while (j < children.length) {
          const c = children[j];
          if (c.type === 'html' && typeof c.value === 'string' && c.value.trim().toLowerCase() === closeTag) {
            found = true;
            break;
          }
          inner.push(c);
          j++;
        }
        if (found) {
          if (tagName === 'code') {
            // Combine inner text into a single inlineCode node
            const text = inner.map(n => n.value ?? '').join('');
            result.push({ type: 'inlineCode', value: text });
          } else {
            // strong, em, del — wrap inner nodes
            const mdastType = tagName === 'strong' ? 'strong' : tagName === 'em' ? 'emphasis' : 'delete';
            result.push({ type: mdastType, children: convertHtmlFormatting(inner) });
          }
          i = j + 1; // skip past closing tag
          continue;
        }
      }
    }
    result.push(child);
    i++;
  }
  return result;
}

function visit(node: MdastNode): void {
  if (!node.children) return;
  normalizeSplitAgentdocSpans(node as MdastParent);
  normalizeHtmlFormattingInAgentdocMarks(node);
  const children = node.children;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string' && isAgentdocHtml(child.value)) {
      const parsed = parseAgentdocHtml(child.value);
      if (parsed) {
        children.splice(i, 1, ...parsed);
        i += parsed.length - 1;
        continue;
      }
    }

    if (child.children) {
      visit(child);
    }
  }
}

export function remarkAgentdocMarks() {
  return (tree: MdastNode) => {
    visit(tree);
  };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInlineNodes(nodes?: MdastNode[]): string {
  if (!nodes || nodes.length === 0) return '';
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: MdastNode): string {
  switch (node.type) {
    case 'text':
      return node.value ?? '';
    case 'strong':
      return `**${renderInlineNodes(node.children)}**`;
    case 'emphasis':
      return `*${renderInlineNodes(node.children)}*`;
    case 'delete':
      return `~~${renderInlineNodes(node.children)}~~`;
    case 'inlineCode': {
      const val = node.value ?? '';
      // Use double backticks if value contains a backtick
      if (val.includes('`')) return `\`\` ${val} \`\``;
      return `\`${val}\``;
    }
    case 'link': {
      const href = String((node as MdastNode & { url?: string }).url ?? '');
      const text = renderInlineNodes(node.children);
      return `[${text}](${href})`;
    }
    case 'image': {
      const src = String((node as MdastNode & { url?: string }).url ?? '');
      const alt = String((node as MdastNode & { alt?: string }).alt ?? '');
      return `![${alt}](${src})`;
    }
    case 'break':
      return `\\\n`;
    case 'html':
      return typeof node.value === 'string' ? node.value : '';
    case 'agentdocMark':
      return renderAgentdocMarkNode(node as AgentdocMarkNode);
    default:
      if (node.children && node.children.length > 0) {
        return renderInlineNodes(node.children);
      }
      return node.value ?? '';
  }
}

function renderAgentdocMarkNode(node: AgentdocMarkNode): string {
  const markKind = node.markKind || 'comment';
  const attrs = node.attrs ?? {};
  const parts: string[] = [];

  parts.push(`data-agentdoc="${escapeAttr(markKind)}"`);

  if (attrs.id) {
    parts.push(
      markKind === 'authored'
        ? `data-agentdoc-id="${escapeAttr(String(attrs.id))}"`
        : `data-id="${escapeAttr(String(attrs.id))}"`,
    );
  }
  if (attrs.by) {
    parts.push(`data-by="${escapeAttr(String(attrs.by))}"`);
  }
  if (markKind === 'suggestion' && attrs.kind) {
    parts.push(`data-kind="${escapeAttr(String(attrs.kind))}"`);
  }

  const content = renderInlineNodes(node.children as MdastNode[] | undefined);
  return `<span ${parts.join(' ')}>${content}</span>`;
}

export function agentdocMarkHandler(
  this: any,
  node: AgentdocMarkNode,
  _parent?: unknown,
  state?: { containerPhrasing?: (node: AgentdocMarkNode, info?: Record<string, unknown>) => string },
  info?: Record<string, unknown>
): string {
  void state;
  void info;
  return renderAgentdocMarkNode(node);
}

export type { AgentdocMarkNode, MdastNode, MdastParent };
