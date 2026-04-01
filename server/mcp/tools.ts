/**
 * MCP tool definitions for AgentDoc.
 * These expose document CRUD operations as MCP tools that Claude Code can call.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  getDocumentBySlug,
  listActiveDocuments,
  createDocument,
  createDocumentAccessToken,
  getDocumentVisibility,
  getDocumentOwnerEmail,
  setDocumentOwnerEmail,
  setDocumentVisibility,
  getDocumentViewCount,
  isDocumentArchived,
  addEvent,
  updateMarks,
  upsertMarkTombstone,
} from '../db.js';
import type { DocumentRow } from '../db.js';
import { generateSlug } from '../slug.js';
import { randomUUID } from 'crypto';
import {
  getDocumentShares,
  addDocumentShare,
  removeDocumentShare,
  hasDocumentAccess,
} from './sharing.js';
import { canonicalizeStoredMarks } from '../../src/formats/marks.js';

type StoredMark = {
  kind?: string;
  by?: string;
  createdAt?: string;
  range?: { from: number; to: number };
  quote?: string;
  text?: string;
  thread?: unknown;
  threadId?: string;
  replies?: Array<{ by: string; text: string; at: string }>;
  resolved?: boolean;
  content?: string;
  status?: 'pending' | 'accepted' | 'rejected';
  [key: string]: unknown;
};

function parseMarks(raw: string): Record<string, StoredMark> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
    }
    return {};
  } catch {
    return {};
  }
}

const PUBLIC_URL = () => (process.env.PUBLIC_URL || 'https://agentdoc.up.railway.app').replace(/\/$/, '');

/**
 * Extract a document slug from either a raw slug or a full URL.
 */
function parseSlugOrUrl(input: string): string {
  // If it looks like a URL, extract the slug
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/d\/([^/?]+)/);
    if (match) return match[1];
    const docMatch = url.pathname.match(/^\/documents\/([^/?]+)/);
    if (docMatch) return docMatch[1];
  } catch {
    // Not a URL, treat as slug
  }
  return input.trim();
}

/**
 * Check if the authenticated user can access a document.
 */
function canAccess(doc: DocumentRow, userEmail: string): boolean {
  // Owner always has access
  const ownerEmail = getDocumentOwnerEmail(doc.slug);
  if (ownerEmail && ownerEmail === userEmail) return true;

  const visibility = getDocumentVisibility(doc.slug);

  // Public docs are accessible to all
  if (visibility === 'public') return true;

  // Selective: only explicitly shared users
  if (visibility === 'selective') {
    return hasDocumentAccess(doc.slug, userEmail);
  }

  // Shared (organization): check per-user shares + domain-based access
  if (visibility === 'shared') {
    if (hasDocumentAccess(doc.slug, userEmail)) return true;
    const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';
    const emailDomain = userEmail.split('@')[1];
    if (emailDomain === allowedDomain) return true;
  }

  return false;
}

/**
 * Get the authenticated user's email from the auth info.
 */
function getUserEmail(extra?: Record<string, unknown>): string {
  return (extra?.userEmail as string) || 'unknown';
}

function getUserName(extra?: Record<string, unknown>): string {
  return (extra?.userName as string) || 'unknown';
}

/**
 * Register all document tools on the MCP server.
 */
export function registerTools(mcp: McpServer): void {
  // --- read_document ---
  mcp.tool(
    'read_document',
    'Read an AgentDoc document by slug or URL. Returns the document title, markdown content, and metadata.',
    {
      slug_or_url: z.string().describe('Document slug (e.g. "abc123xy") or full URL (e.g. "https://agentdoc.up.railway.app/d/abc123xy")'),
    },
    async (args, extra) => {
      const slug = parseSlugOrUrl(args.slug_or_url);
      const doc = getDocumentBySlug(slug);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document not found: ${slug}` }], isError: true };
      }

      const userEmail = getUserEmail(extra.authInfo?.extra);
      if (!canAccess(doc, userEmail)) {
        return { content: [{ type: 'text' as const, text: `Access denied. You (${userEmail}) don't have access to this document.` }], isError: true };
      }

      const visibility = getDocumentVisibility(slug);
      const ownerEmail = getDocumentOwnerEmail(slug);
      const viewCount = getDocumentViewCount(slug);
      const shares = getDocumentShares(slug);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            slug: doc.slug,
            title: doc.title || 'Untitled',
            markdown: doc.markdown,
            author: doc.owner_id,
            ownerEmail,
            visibility,
            viewCount,
            sharedWith: shares.map((s) => ({ email: s.email, role: s.role })),
            revision: doc.revision,
            createdAt: doc.created_at,
            updatedAt: doc.updated_at,
            url: `${PUBLIC_URL()}/d/${doc.slug}`,
          }, null, 2),
        }],
      };
    },
  );

  // --- list_documents ---
  mcp.tool(
    'list_documents',
    'List AgentDoc documents accessible to you. Returns titles, slugs, and metadata.',
    {
      filter: z.enum(['all', 'owned', 'shared_with_me']).optional().default('all').describe('Filter documents: all, owned, or shared_with_me'),
    },
    async (args, extra) => {
      const userEmail = getUserEmail(extra.authInfo?.extra);
      const allDocs = listActiveDocuments();

      let filtered: DocumentRow[];
      if (args.filter === 'owned') {
        filtered = allDocs.filter((d) => {
          const ownerEmail = getDocumentOwnerEmail(d.slug);
          return ownerEmail === userEmail;
        });
      } else if (args.filter === 'shared_with_me') {
        filtered = allDocs.filter((d) => {
          const ownerEmail = getDocumentOwnerEmail(d.slug);
          if (ownerEmail === userEmail) return false;
          return canAccess(d, userEmail);
        });
      } else {
        filtered = allDocs.filter((d) => !isDocumentArchived(d.slug) && canAccess(d, userEmail));
      }

      const documents = filtered.map((d) => ({
        slug: d.slug,
        title: d.title || 'Untitled',
        author: d.owner_id,
        ownerEmail: getDocumentOwnerEmail(d.slug),
        visibility: getDocumentVisibility(d.slug),
        viewCount: getDocumentViewCount(d.slug),
        createdAt: d.created_at,
        updatedAt: d.updated_at,
        url: `${PUBLIC_URL()}/d/${d.slug}`,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: documents.length, documents }, null, 2),
        }],
      };
    },
  );

  // --- create_document ---
  mcp.tool(
    'create_document',
    'Create a new AgentDoc document. Returns the document URL and access tokens.',
    {
      title: z.string().describe('Document title'),
      markdown: z.string().describe('Document content in markdown format'),
      visibility: z.enum(['private', 'selective', 'shared', 'public']).optional().default('private').describe('Document visibility: private (only you), selective (specific people), shared (org), public (anyone)'),
      share_with: z.array(z.string()).optional().describe('Email addresses to share the document with (for shared visibility)'),
      role: z.enum(['viewer', 'commenter', 'editor']).optional().default('editor').describe('Default access role for shared users'),
    },
    async (args, extra) => {
      const userEmail = getUserEmail(extra.authInfo?.extra);
      const userName = getUserName(extra.authInfo?.extra);
      const ownerId = `oauth_user:${userName}`;

      const slug = generateSlug();
      const ownerSecret = randomUUID();
      const doc = createDocument(slug, args.markdown, {}, args.title, ownerId, ownerSecret);
      const access = createDocumentAccessToken(slug, args.role);

      // Set owner email
      setDocumentOwnerEmail(slug, userEmail);

      // Set visibility
      if (args.visibility !== 'private') {
        setDocumentVisibility(slug, args.visibility);
      }

      // Add per-user shares
      if (args.share_with && args.share_with.length > 0) {
        for (const email of args.share_with) {
          addDocumentShare(slug, email.trim(), args.role, userEmail);
        }
      }

      addEvent(slug, 'document.created', {
        title: args.title,
        ownerId,
        ownerEmail: userEmail,
        source: 'mcp',
        visibility: args.visibility,
      }, ownerId);

      const publicUrl = PUBLIC_URL();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            slug: doc.slug,
            title: args.title,
            url: `${publicUrl}/d/${doc.slug}`,
            tokenUrl: `${publicUrl}/d/${doc.slug}?token=${access.secret}`,
            ownerSecret,
            accessToken: access.secret,
            visibility: args.visibility,
            sharedWith: args.share_with || [],
          }, null, 2),
        }],
      };
    },
  );

  // --- edit_document ---
  mcp.tool(
    'edit_document',
    'Edit an existing AgentDoc document. Can rewrite content, update title, or change visibility.',
    {
      slug_or_url: z.string().describe('Document slug or full URL'),
      markdown: z.string().optional().describe('New markdown content (full rewrite)'),
      title: z.string().optional().describe('New document title'),
      visibility: z.enum(['private', 'selective', 'shared', 'public']).optional().describe('New visibility setting'),
    },
    async (args, extra) => {
      const slug = parseSlugOrUrl(args.slug_or_url);
      const doc = getDocumentBySlug(slug);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document not found: ${slug}` }], isError: true };
      }

      const userEmail = getUserEmail(extra.authInfo?.extra);
      const ownerEmail = getDocumentOwnerEmail(slug);

      // Only owner, explicit editors, or domain users on shared/public docs can edit
      if (ownerEmail !== userEmail) {
        const shares = getDocumentShares(slug);
        const userShare = shares.find((s) => s.email === userEmail);
        if (userShare && userShare.role === 'editor') {
          // Explicitly shared with editor role — allow
        } else if (userShare) {
          // Explicit non-editor share (viewer/commenter) — deny edit access
          return { content: [{ type: 'text' as const, text: `Access denied. You (${userEmail}) have ${userShare.role} access but need editor access to modify this document.` }], isError: true };
        } else {
          // No explicit share — check domain-based access for shared/public docs
          const visibility = getDocumentVisibility(slug);
          const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN || 'cultivarium.org';
          const emailDomain = userEmail.split('@')[1];
          if (!((visibility === 'shared' || visibility === 'public') && emailDomain === allowedDomain)) {
            return { content: [{ type: 'text' as const, text: `Access denied. You (${userEmail}) need editor access to modify this document.` }], isError: true };
          }
        }
      }

      // Only owner can change visibility
      if (args.visibility && ownerEmail !== userEmail) {
        return { content: [{ type: 'text' as const, text: `Only the document owner can change visibility.` }], isError: true };
      }

      const changes: string[] = [];

      if (args.markdown !== undefined) {
        const { updateDocument } = await import('../db.js');
        updateDocument(slug, args.markdown);
        changes.push('content updated');
      }

      if (args.title !== undefined) {
        const { updateDocumentTitle } = await import('../db.js');
        updateDocumentTitle(slug, args.title);
        changes.push(`title changed to "${args.title}"`);
      }

      if (args.visibility) {
        setDocumentVisibility(slug, args.visibility);
        changes.push(`visibility set to ${args.visibility}`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            slug,
            changes,
            url: `${PUBLIC_URL()}/d/${slug}`,
          }, null, 2),
        }],
      };
    },
  );

  // --- share_document ---
  mcp.tool(
    'share_document',
    'Share an AgentDoc document with specific users by email. Only the document owner can manage shares.',
    {
      slug_or_url: z.string().describe('Document slug or full URL'),
      action: z.enum(['add', 'remove', 'list']).describe('Action: add users, remove users, or list current shares'),
      emails: z.array(z.string()).optional().describe('Email addresses to add or remove (required for add/remove)'),
      role: z.enum(['viewer', 'commenter', 'editor']).optional().default('editor').describe('Access role for added users'),
    },
    async (args, extra) => {
      const slug = parseSlugOrUrl(args.slug_or_url);
      const doc = getDocumentBySlug(slug);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document not found: ${slug}` }], isError: true };
      }

      const userEmail = getUserEmail(extra.authInfo?.extra);
      const ownerEmail = getDocumentOwnerEmail(slug);
      if (ownerEmail !== userEmail) {
        return { content: [{ type: 'text' as const, text: `Only the document owner can manage shares.` }], isError: true };
      }

      if (args.action === 'list') {
        const shares = getDocumentShares(slug);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              slug,
              visibility: getDocumentVisibility(slug),
              shares: shares.map((s) => ({ email: s.email, role: s.role, grantedAt: s.created_at })),
            }, null, 2),
          }],
        };
      }

      if (!args.emails || args.emails.length === 0) {
        return { content: [{ type: 'text' as const, text: 'emails is required for add/remove actions' }], isError: true };
      }

      if (args.action === 'add') {
        for (const email of args.emails) {
          addDocumentShare(slug, email.trim(), args.role, userEmail);
        }
        // Auto-set visibility to selective if it's private
        const currentVis = getDocumentVisibility(slug);
        if (currentVis === 'private') {
          setDocumentVisibility(slug, 'selective');
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              action: 'added',
              emails: args.emails,
              role: args.role,
              visibility: getDocumentVisibility(slug),
            }, null, 2),
          }],
        };
      }

      if (args.action === 'remove') {
        for (const email of args.emails) {
          removeDocumentShare(slug, email.trim());
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              action: 'removed',
              emails: args.emails,
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: 'Unknown action' }], isError: true };
    },
  );

  // --- list_comments ---
  mcp.tool(
    'list_comments',
    'List all comments on an AgentDoc document. Returns each comment with its id, text, author, timestamp, quoted/highlighted text, resolved status, and replies.',
    {
      slug_or_url: z.string().describe('Document slug (e.g. "abc123xy") or full URL (e.g. "https://agentdoc.up.railway.app/d/abc123xy")'),
    },
    async (args, extra) => {
      const slug = parseSlugOrUrl(args.slug_or_url);
      const doc = getDocumentBySlug(slug);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document not found: ${slug}` }], isError: true };
      }

      const userEmail = getUserEmail(extra.authInfo?.extra);
      if (!canAccess(doc, userEmail)) {
        return { content: [{ type: 'text' as const, text: `Access denied. You (${userEmail}) don't have access to this document.` }], isError: true };
      }

      const marks = parseMarks(doc.marks);
      const comments = Object.entries(marks)
        .filter(([, mark]) => mark.kind === 'comment')
        .map(([id, mark]) => ({
          id,
          text: mark.text || '',
          author: mark.by || 'unknown',
          createdAt: mark.createdAt || null,
          quote: mark.quote || null,
          resolved: mark.resolved ?? false,
          replies: (Array.isArray(mark.replies) ? mark.replies : (Array.isArray(mark.thread) ? mark.thread : [])).map(
            (r: { by?: string; text?: string; at?: string }) => ({
              author: r.by || 'unknown',
              text: r.text || '',
              createdAt: r.at || null,
            }),
          ),
        }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            slug,
            count: comments.length,
            comments,
          }, null, 2),
        }],
      };
    },
  );

  // --- resolve_comment ---
  mcp.tool(
    'resolve_comment',
    'Resolve (mark as resolved) a comment on an AgentDoc document. The comment will no longer appear as an active highlight.',
    {
      slug_or_url: z.string().describe('Document slug or full URL'),
      comment_id: z.string().describe('The comment ID to resolve (from list_comments)'),
    },
    async (args, extra) => {
      const slug = parseSlugOrUrl(args.slug_or_url);
      const doc = getDocumentBySlug(slug);
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Document not found: ${slug}` }], isError: true };
      }

      const userEmail = getUserEmail(extra.authInfo?.extra);
      if (!canAccess(doc, userEmail)) {
        return { content: [{ type: 'text' as const, text: `Access denied. You (${userEmail}) don't have access to this document.` }], isError: true };
      }

      const marks = parseMarks(doc.marks);
      const existing = marks[args.comment_id];
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Comment not found: ${args.comment_id}` }], isError: true };
      }

      if (existing.kind !== 'comment') {
        return { content: [{ type: 'text' as const, text: `Mark ${args.comment_id} is not a comment (kind: ${existing.kind})` }], isError: true };
      }

      if (existing.resolved) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              comment_id: args.comment_id,
              alreadyResolved: true,
              message: 'Comment was already resolved.',
            }, null, 2),
          }],
        };
      }

      marks[args.comment_id] = { ...existing, resolved: true };
      const actor = `oauth_user:${getUserName(extra.authInfo?.extra)}`;
      const ok = updateMarks(slug, marks as unknown as Record<string, unknown>);
      if (!ok) {
        return { content: [{ type: 'text' as const, text: 'Failed to update marks. The document may be in a read-only state.' }], isError: true };
      }

      addEvent(slug, 'comment.resolved', { markId: args.comment_id, by: actor, source: 'mcp' }, actor);

      // Record tombstone so the resolved mark isn't resurrected by collab sync
      const updated = getDocumentBySlug(slug);
      const resolvedRevision = typeof updated?.revision === 'number' ? updated.revision : (doc.revision + 1);
      upsertMarkTombstone(slug, args.comment_id, 'resolved', resolvedRevision);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            comment_id: args.comment_id,
            slug,
            message: 'Comment resolved successfully.',
          }, null, 2),
        }],
      };
    },
  );
}
