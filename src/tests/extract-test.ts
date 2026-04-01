import { extractMarks } from '../formats/marks.js';

const content = `# Test Document

This is a <span data-proof="comment" data-id="m123" data-by="human:test">test paragraph</span> for comments.

Another paragraph here.

<!-- AGENTDOC
{
  "version": 2,
  "marks": {
    "m123": {
      "kind": "comment",
      "by": "human:test",
      "createdAt": "2026-01-20T22:52:03.086Z",
      "text": "This is a test comment",
      "threadId": "t123",
      "thread": [],
      "resolved": false
    }
  }
}
-->

<!-- AGENTDOC:END -->
`;

const result = extractMarks(content);
console.log('=== cleanContent ===');
console.log(JSON.stringify(result.content));
console.log('');
console.log('=== marks ===');
console.log(JSON.stringify(result.marks, null, 2));
