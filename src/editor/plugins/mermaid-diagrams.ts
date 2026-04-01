import { $prose } from '@milkdown/kit/utils';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@milkdown/kit/prose/view';
import { parseMermaid, renderMermaidSVG } from 'beautiful-mermaid';

const mermaidDiagramsKey = new PluginKey('mermaid-diagrams');
const MERMAID_LANGUAGE = 'mermaid';
const MERMAID_CONNECTOR_TOKENS = ['---', '-->', '==>', '-.->', '==', '--', '~~'];
const MERMAID_LINE_DIRECTIVES = /^(classDef|class|linkStyle|style|click|subgraph|end)\b/i;
const MERMAID_DANGLING_EDGE_PATTERN = /(?:---|-->|==>|-\.\->|==|--|~~)\s*(?:\|[^|]*\|\s*)?$/;

function normalizeCodeBlockLanguage(language: unknown): string {
  if (typeof language !== 'string') return '';
  return language.trim().toLowerCase();
}

export function isMermaidCodeBlockLanguage(language: unknown): boolean {
  return normalizeCodeBlockLanguage(language) === MERMAID_LANGUAGE;
}

function stripMermaidLineComment(line: string): string {
  const commentIndex = line.indexOf('%%');
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function sourceContainsConnector(source: string): boolean {
  return source
    .split('\n')
    .map(stripMermaidLineComment)
    .some((line) => MERMAID_CONNECTOR_TOKENS.some((token) => line.includes(token)));
}

function findDanglingEdgeLine(source: string): string | null {
  const lines = source.split('\n');
  for (const rawLine of lines) {
    const line = stripMermaidLineComment(rawLine).trim();
    if (!line || MERMAID_LINE_DIRECTIVES.test(line)) continue;
    if (MERMAID_DANGLING_EDGE_PATTERN.test(line)) {
      return rawLine.trim();
    }
  }
  return null;
}

export function validateMermaidSource(source: string): void {
  const graph = parseMermaid(source);
  const danglingEdgeLine = findDanglingEdgeLine(source);
  if (danglingEdgeLine) {
    throw new Error(`Dangling Mermaid edge: "${danglingEdgeLine}"`);
  }
  if (sourceContainsConnector(source) && graph.edges.length === 0) {
    throw new Error('Mermaid diagram includes connectors but no valid edges were parsed.');
  }
}

export function renderAgentdocMermaidSvg(source: string): string {
  validateMermaidSource(source);
  return renderMermaidSVG(source, {
    bg: 'var(--bg-color)',
    fg: 'var(--text-color)',
    font: 'Inter',
    padding: 28,
    nodeSpacing: 32,
    layerSpacing: 52,
    transparent: true,
  });
}

function isShareDocumentPage(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname;
  return path.startsWith('/d/');
}

function sanitizeSvg(svgMarkup: string): SVGSVGElement | null {
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(svgMarkup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;

  const svg = parsed.documentElement;
  if (!(svg instanceof SVGSVGElement) || svg.tagName.toLowerCase() !== 'svg') {
    return null;
  }

  const blockedTags = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);
  const walker = parsed.createTreeWalker(svg, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element);
  }

  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    if (blockedTags.has(tagName)) {
      element.remove();
      continue;
    }

    for (const attributeName of element.getAttributeNames()) {
      const normalizedName = attributeName.toLowerCase();
      const value = element.getAttribute(attributeName) ?? '';
      if (normalizedName.startsWith('on')) {
        element.removeAttribute(attributeName);
        continue;
      }
      if ((normalizedName === 'href' || normalizedName === 'xlink:href') && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attributeName);
      }
    }
  }

  return document.importNode(svg, true) as SVGSVGElement;
}

class MermaidCodeBlockView implements NodeView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLElement;

  private readonly preview: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly sourceDetails: HTMLDetailsElement;
  private readonly sourceSummary: HTMLElement;
  private readonly pre: HTMLPreElement;
  private currentLanguage = '';
  private currentSource = '';

  constructor(node: ProseMirrorNode, _view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'agentdoc-code-block';

    this.preview = document.createElement('div');
    this.preview.className = 'agentdoc-mermaid-preview';
    this.preview.hidden = true;
    this.preview.setAttribute('contenteditable', 'false');

    this.status = document.createElement('div');
    this.status.className = 'agentdoc-mermaid-status';
    this.status.hidden = true;
    this.status.setAttribute('contenteditable', 'false');

    this.sourceDetails = document.createElement('details');
    this.sourceDetails.className = 'agentdoc-mermaid-source';
    this.sourceDetails.open = !isShareDocumentPage();

    this.sourceSummary = document.createElement('summary');
    this.sourceSummary.className = 'agentdoc-mermaid-source-summary';
    this.sourceSummary.textContent = 'Mermaid source';
    this.sourceSummary.setAttribute('contenteditable', 'false');

    this.pre = document.createElement('pre');
    this.pre.className = 'agentdoc-code-block-pre';

    this.contentDOM = document.createElement('code');

    this.pre.appendChild(this.contentDOM);
    this.sourceDetails.append(this.sourceSummary);
    this.dom.append(this.pre);

    this.update(node);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== 'code_block') return false;

    const nextLanguage = normalizeCodeBlockLanguage(node.attrs?.language);
    const nextSource = node.textContent;
    const changed = nextLanguage !== this.currentLanguage || nextSource !== this.currentSource;

    this.currentLanguage = nextLanguage;
    this.currentSource = nextSource;
    this.pre.dataset.language = this.currentLanguage || '';

    if (!changed) return true;

    const isMermaid = isMermaidCodeBlockLanguage(this.currentLanguage);
    this.dom.classList.toggle('agentdoc-mermaid-block', isMermaid);
    this.preview.hidden = !isMermaid;
    this.status.hidden = true;

    if (!isMermaid) {
      if (this.pre.parentElement !== this.dom) {
        this.pre.remove();
        this.dom.replaceChildren(this.pre);
      }
      this.preview.replaceChildren();
      this.sourceDetails.open = true;
      return true;
    }

    try {
      const svgElement = sanitizeSvg(renderAgentdocMermaidSvg(this.currentSource));
      if (!svgElement) throw new Error('Invalid SVG output');

      svgElement.classList.add('agentdoc-mermaid-svg');
      svgElement.setAttribute('aria-label', 'Rendered Mermaid diagram');
      svgElement.setAttribute('role', 'img');
      this.preview.replaceChildren(svgElement);
      this.status.hidden = true;
      this.status.textContent = '';
      if (this.pre.parentElement !== this.sourceDetails) {
        this.pre.remove();
        this.sourceDetails.append(this.pre);
      }
      this.dom.replaceChildren(this.preview, this.status, this.sourceDetails);
      if (isShareDocumentPage()) {
        this.sourceDetails.open = false;
      }
    } catch (error) {
      this.preview.replaceChildren();
      this.status.hidden = false;
      this.status.textContent = error instanceof Error
        ? `Unable to render Mermaid diagram: ${error.message}`
        : 'Unable to render Mermaid diagram.';
      this.sourceDetails.open = true;
      if (this.pre.parentElement !== this.sourceDetails) {
        this.pre.remove();
        this.sourceDetails.append(this.pre);
      }
      this.dom.replaceChildren(this.preview, this.status, this.sourceDetails);
    }

    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.sourceSummary.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

export const mermaidDiagramsPlugin = $prose(() => {
  return new Plugin({
    key: mermaidDiagramsKey,
    props: {
      nodeViews: {
        code_block(node, view) {
          return new MermaidCodeBlockView(node, view);
        },
      },
    },
  });
});
