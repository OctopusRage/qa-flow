import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

type SlackResponse = { ok: boolean; error?: string; [k: string]: unknown };

async function call(token: string, method: string, body: Record<string, unknown>, form = false): Promise<SlackResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
    },
    body: form
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
      : JSON.stringify(body),
  });
  const json = (await res.json()) as SlackResponse;
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? res.status}`);
  return json;
}

export async function authTest(token: string) {
  const r = await call(token, 'auth.test', {});
  return { team: String(r.team), user: String(r.user), url: String(r.url) };
}

/**
 * Accepts a channel id (C…), "#name", or a message permalink
 * (https://x.slack.com/archives/C123/p1790217638419739[?thread_ts=…]) → channel + thread.
 */
export async function resolveTarget(token: string, target: string, threadInput?: string): Promise<{ channel: string; threadTs?: string }> {
  const fromLink = (s: string) => {
    const m = s.match(/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
    if (!m) return null;
    const thread = s.match(/thread_ts=(\d+\.\d+)/)?.[1];
    return { channel: m[1], threadTs: thread ?? `${m[2]}.${m[3]}` };
  };
  const threadLink = threadInput ? fromLink(threadInput) : null;
  if (threadLink) return threadLink;
  const link = fromLink(target);
  if (link) return link;

  let channel = target.trim();
  if (channel.startsWith('#')) {
    const name = channel.slice(1);
    let cursor = '';
    let found = '';
    do {
      const r = await call(token, 'conversations.list', { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true, cursor }, true);
      const hit = (r.channels as { id: string; name: string }[]).find((c) => c.name === name);
      if (hit) found = hit.id;
      cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '';
    } while (!found && cursor);
    if (!found) throw new Error(`Channel #${name} not found (or the token's user is not in it)`);
    channel = found;
  }
  const threadTs = threadInput?.trim().match(/^\d+\.\d+$/) ? threadInput.trim() : undefined;
  return { channel, threadTs };
}

export type PostResult = { channel: string; ts: string; permalink?: string };

/** Post text plus images. Slack takes at most 10 files per message, so extra images follow as replies. */
export async function postReport(token: string, channel: string, threadTs: string | undefined, text: string, images: { path: string; title: string }[]): Promise<PostResult> {
  if (!images.length) {
    const r = await call(token, 'chat.postMessage', { channel, text, thread_ts: threadTs, unfurl_links: false });
    const ts = String(r.ts);
    return { channel, ts, permalink: await permalink(token, channel, ts) };
  }

  let first: PostResult | null = null;
  for (let i = 0; i < images.length; i += 10) {
    const batch = images.slice(i, i + 10);
    const files: { id: string; title: string }[] = [];
    for (const img of batch) {
      const bytes = readFileSync(img.path);
      const up = await call(token, 'files.getUploadURLExternal', { filename: basename(img.path), length: statSync(img.path).size }, true);
      const put = await fetch(String(up.upload_url), { method: 'POST', body: bytes });
      if (!put.ok) throw new Error(`Slack upload failed: HTTP ${put.status}`);
      files.push({ id: String(up.file_id), title: img.title.slice(0, 250) });
    }
    const comment = i === 0 ? text : `(screenshots ${i + 1}–${i + batch.length} of ${images.length})`;
    await call(token, 'files.completeUploadExternal', {
      files,
      channel_id: channel,
      initial_comment: comment,
      // Later batches go under the first message when there is no thread yet.
      thread_ts: threadTs ?? first?.ts,
    });
    if (!first) {
      const ts = await shareTs(token, files[0].id, channel);
      first = { channel, ts: ts ?? '', permalink: ts ? await permalink(token, channel, ts) : undefined };
      if (!threadTs && !ts && images.length > 10) {
        throw new Error('Posted the first 10 screenshots but could not find the message to thread the rest under');
      }
    }
  }
  return first!;
}

/** The upload share is created asynchronously; poll files.info briefly for its message ts. */
async function shareTs(token: string, fileId: string, channel: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call(token, 'files.info', { file: fileId }, true);
    const shares = (r.file as { shares?: Record<string, Record<string, { ts: string }[]>> }).shares ?? {};
    for (const scope of Object.values(shares)) {
      const ts = scope[channel]?.[0]?.ts;
      if (ts) return ts;
    }
  }
  return undefined;
}

async function permalink(token: string, channel: string, ts: string): Promise<string | undefined> {
  try {
    const r = await call(token, 'chat.getPermalink', { channel, message_ts: ts }, true);
    return String(r.permalink);
  } catch {
    return undefined;
  }
}
