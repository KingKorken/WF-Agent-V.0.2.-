#!/usr/bin/env node
/**
 * Spotify Skill — Layer 1 CLI for Spotify Web API.
 *
 * Uses the Spotify REST API (https://developer.spotify.com/documentation/web-api)
 * via Node.js built-in https module.
 *
 * Environment Variables Required:
 *   SPOTIFY_CLIENT_ID     — Your Spotify app client ID
 *   SPOTIFY_CLIENT_SECRET — Your Spotify app client secret
 *   SPOTIFY_REFRESH_TOKEN — A valid refresh token with required scopes
 *
 * Commands:
 *   now-playing            Get the currently playing track
 *   play                   [--uri <uri>] [--device-id <id>]  Resume or play a specific URI
 *   pause                  [--device-id <id>]  Pause playback
 *   next                   [--device-id <id>]  Skip to next track
 *   previous               [--device-id <id>]  Skip to previous track
 *   search                 --query <q> --type <type> [--limit N]  Search (types: track,album,artist,playlist)
 *   get-playlist           --playlist-id <id>  Get playlist details and tracks
 *   list-playlists         [--limit N]  List current user's playlists
 *   get-queue              Get current playback queue
 *   add-to-queue           --uri <uri> [--device-id <id>]  Add a track to the queue
 *   set-volume             --volume <0-100> [--device-id <id>]  Set playback volume
 *   list-devices           List available playback devices
 *   get-recommendations    --seed-tracks <ids> [--seed-artists <ids>] [--seed-genres <genres>] [--limit N]
 *   get-track              --track-id <id>  Get track details
 *   get-artist             --artist-id <id>  Get artist details
 *   get-album              --album-id <id>  Get album details
 *   create-playlist        --name <name> [--description <desc>] [--public true|false]
 *   add-to-playlist        --playlist-id <id> --uris <uri1,uri2,...>
 *   saved-tracks           [--limit N]  Get user's saved/liked tracks
 *   save-track             --track-id <id>  Save a track to user's library
 *   remove-track           --track-id <id>  Remove a track from user's library
 *   top-items              --type <artists|tracks> [--limit N] [--time-range <short_term|medium_term|long_term>]
 *   help                   Show available commands
 *
 * All commands return JSON to stdout.
 */

import { execFile } from 'child_process';
import * as https from 'https';
import * as querystring from 'querystring';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiResponse {
  statusCode?: number;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function ok(data: unknown): void {
  console.log(JSON.stringify({ success: true, data }));
}

function fail(message: string): void {
  console.log(JSON.stringify({ success: false, error: message }));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed: unknown = data;
        if (data && data.trim()) {
          try { parsed = JSON.parse(data); } catch { parsed = data; }
        } else {
          parsed = null;
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsGet(url: string, headers: Record<string, string>): Promise<ApiResponse> {
  return httpsRequest(url, { method: 'GET', headers });
}

function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<ApiResponse> {
  const hdrs = { ...headers, 'Content-Length': Buffer.byteLength(body).toString() };
  return httpsRequest(url, { method: 'POST', headers: hdrs }, body);
}

function httpsPut(
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<ApiResponse> {
  const hdrs = { ...headers };
  if (body) hdrs['Content-Length'] = Buffer.byteLength(body).toString();
  return httpsRequest(url, { method: 'PUT', headers: hdrs }, body);
}

function httpsDelete(
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<ApiResponse> {
  const hdrs = { ...headers };
  if (body) hdrs['Content-Length'] = Buffer.byteLength(body).toString();
  return httpsRequest(url, { method: 'DELETE', headers: hdrs }, body);
}

// ---------------------------------------------------------------------------
// Spotify Auth — Client Credentials + Refresh Token flow
// ---------------------------------------------------------------------------

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 10_000) {
    return cachedAccessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables are required.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let bodyStr: string;
  if (refreshToken) {
    bodyStr = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } else {
    bodyStr = querystring.stringify({ grant_type: 'client_credentials' });
  }

  const response = await httpsPost(
    'https://accounts.spotify.com/api/token',
    {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    bodyStr
  );

  const data = response.body as Record<string, unknown>;
  if (!data || !data['access_token']) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data['access_token'] as string;
  tokenExpiresAt = Date.now() + ((data['expires_in'] as number) || 3600) * 1000;
  return cachedAccessToken;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Spotify API helpers
// ---------------------------------------------------------------------------

const BASE = 'https://api.spotify.com/v1';

function checkError(response: ApiResponse, context: string): boolean {
  const body = response.body as Record<string, unknown> | null;
  if (response.statusCode && response.statusCode >= 400) {
    const errBody = body?.['error'] as Record<string, unknown> | undefined;
    const msg = errBody?.['message'] || JSON.stringify(body) || 'Unknown error';
    fail(`${context}: ${msg} (HTTP ${response.statusCode})`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function nowPlaying(_args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/me/player/currently-playing`, headers);

    if (response.statusCode === 204 || response.body === null) {
      ok({ message: 'Nothing is currently playing.' });
      return;
    }

    if (checkError(response, 'now-playing')) return;

    const data = response.body as Record<string, unknown>;
    const item = data['item'] as Record<string, unknown> | null;
    if (!item) {
      ok({ message: 'Nothing is currently playing.' });
      return;
    }

    const artists = (item['artists'] as Array<Record<string, unknown>>)
      ?.map((a) => a['name'] as string)
      .join(', ');
    const album = (item['album'] as Record<string, unknown>)?.['name'];

    ok({
      is_playing: data['is_playing'],
      track_id: item['id'],
      track_name: item['name'],
      artists,
      album,
      duration_ms: item['duration_ms'],
      progress_ms: data['progress_ms'],
      uri: item['uri'],
    });
  } catch (e: unknown) {
    fail(`now-playing failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function play(args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const deviceId = args['--device-id'];
    const uri = args['--uri'];

    let url = `${BASE}/me/player/play`;
    if (deviceId) url += `?device_id=${encodeURIComponent(deviceId)}`;

    let bodyStr = '{}';
    if (uri) {
      // Determine if it's a track, album, artist, or playlist URI
      if (uri.includes(':track:')) {
        bodyStr = JSON.stringify({ uris: [uri] });
      } else {
        bodyStr = JSON.stringify({ context_uri: uri });
      }
    }

    const response = await httpsPut(url, headers, bodyStr);

    if (response.statusCode === 204) {
      ok({ message: uri ? `Playing ${uri}` : 'Playback resumed.' });
      return;
    }

    if (checkError(response, 'play')) return;
    ok({ message: 'Playback started.' });
  } catch (e: unknown) {
    fail(`play failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function pause(args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const deviceId = args['--device-id'];
    let url = `${BASE}/me/player/pause`;
    if (deviceId) url += `?device_id=${encodeURIComponent(deviceId)}`;

    const response = await httpsPut(url, headers, '{}');

    if (response.statusCode === 204) {
      ok({ message: 'Playback paused.' });
      return;
    }

    if (checkError(response, 'pause')) return;
    ok({ message: 'Playback paused.' });
  } catch (e: unknown) {
    fail(`pause failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function next(args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const deviceId = args['--device-id'];
    let url = `${BASE}/me/player/next`;
    if (deviceId) url += `?device_id=${encodeURIComponent(deviceId)}`;

    const response = await httpsPost(url, headers, '{}');

    if (response.statusCode === 204) {
      ok({ message: 'Skipped to next track.' });
      return;
    }

    if (checkError(response, 'next')) return;
    ok({ message: 'Skipped to next track.' });
  } catch (e: unknown) {
    fail(`next failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function previous(args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const deviceId = args['--device-id'];
    let url = `${BASE}/me/player/previous`;
    if (deviceId) url += `?device_id=${encodeURIComponent(deviceId)}`;

    const response = await httpsPost(url, headers, '{}');

    if (response.statusCode === 204) {
      ok({ message: 'Skipped to previous track.' });
      return;
    }

    if (checkError(response, 'previous')) return;
    ok({ message: 'Skipped to previous track.' });
  } catch (e: unknown) {
    fail(`previous failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function search(args: Record<string, string>): Promise<void> {
  try {
    const query = args['--query'];
    const type = args['--type'] || 'track';
    const limit = args['--limit'] || '10';

    if (!query) {
      fail('search requires --query');
      return;
    }

    const headers = await authHeaders();
    const params = querystring.stringify({ q: query, type, limit, market: 'US' });
    const response = await httpsGet(`${BASE}/search?${params}`, headers);

    if (checkError(response, 'search')) return;

    const data = response.body as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    const types = type.split(',');
    for (const t of types) {
      const key = `${t}s`;
      if (data[key]) {
        const section = data[key] as Record<string, unknown>;
        const items = section['items'] as Array<Record<string, unknown>>;
        result[key] = items.map((item) => {
          const base: Record<string, unknown> = {
            id: item['id'],
            name: item['name'],
            uri: item['uri'],
          };
          if (t === 'track') {
            base['artists'] = (item['artists'] as Array<Record<string, unknown>>)
              ?.map((a) => a['name']);
            base['album'] = (item['album'] as Record<string, unknown>)?.['name'];
            base['duration_ms'] = item['duration_ms'];
          } else if (t === 'album') {
            base['artists'] = (item['artists'] as Array<Record<string, unknown>>)
              ?.map((a) => a['name']);
            base['release_date'] = item['release_date'];
            base['total_tracks'] = item['total_tracks'];
          } else if (t === 'artist') {
            base['genres'] = item['genres'];
            base['followers'] = (item['followers'] as Record<string, unknown>)?.['total'];
          } else if (t === 'playlist') {
            base['owner'] = (item['owner'] as Record<string, unknown>)?.['display_name'];
            base['tracks_total'] = (item['tracks'] as Record<string, unknown>)?.['total'];
          }
          return base;
        });
      }
    }

    ok(result);
  } catch (e: unknown) {
    fail(`search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getPlaylist(args: Record<string, string>): Promise<void> {
  try {
    const playlistId = args['--playlist-id'];
    if (!playlistId) {
      fail('get-playlist requires --playlist-id');
      return;
    }

    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/playlists/${encodeURIComponent(playlistId)}`, headers);

    if (checkError(response, 'get-playlist')) return;

    const data = response.body as Record<string, unknown>;
    const tracksData = data['tracks'] as Record<string, unknown>;
    const trackItems = tracksData?.['items'] as Array<Record<string, unknown>> || [];

    const tracks = trackItems.map((item) => {
      const track = item['track'] as Record<string, unknown> | null;
      if (!track) return null;
      return {
        id: track['id'],
        name: track['name'],
        uri: track['uri'],
        artists: (track['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']),
        album: (track['album'] as Record<string, unknown>)?.['name'],
        duration_ms: track['duration_ms'],
      };
    }).filter(Boolean);

    ok({
      id: data['id'],
      name: data['name'],
      description: data['description'],
      owner: (data['owner'] as Record<string, unknown>)?.['display_name'],
      public: data['public'],
      total_tracks: tracksData?.['total'],
      uri: data['uri'],
      tracks,
    });
  } catch (e: unknown) {
    fail(`get-playlist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function listPlaylists(args: Record<string, string>): Promise<void> {
  try {
    const limit = args['--limit'] || '20';
    const headers = await authHeaders();
    const params = querystring.stringify({ limit });
    const response = await httpsGet(`${BASE}/me/playlists?${params}`, headers);

    if (checkError(response, 'list-playlists')) return;

    const data = response.body as Record<string, unknown>;
    const items = data['items'] as Array<Record<string, unknown>> || [];

    const playlists = items.map((item) => ({
      id: item['id'],
      name: item['name'],
      description: item['description'],
      owner: (item['owner'] as Record<string, unknown>)?.['display_name'],
      public: item['public'],
      total_tracks: (item['tracks'] as Record<string, unknown>)?.['total'],
      uri: item['uri'],
    }));

    ok({ total: data['total'], playlists });
  } catch (e: unknown) {
    fail(`list-playlists failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getQueue(_args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/me/player/queue`, headers);

    if (checkError(response, 'get-queue')) return;

    const data = response.body as Record<string, unknown>;
    const currently = data['currently_playing'] as Record<string, unknown> | null;
    const queue = data['queue'] as Array<Record<string, unknown>> || [];

    const formatTrack = (track: Record<string, unknown>) => ({
      id: track['id'],
      name: track['name'],
      uri: track['uri'],
      artists: (track['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']),
      album: (track['album'] as Record<string, unknown>)?.['name'],
      duration_ms: track['duration_ms'],
    });

    ok({
      currently_playing: currently ? formatTrack(currently) : null,
      queue: queue.slice(0, 20).map(formatTrack),
    });
  } catch (e: unknown) {
    fail(`get-queue failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function addToQueue(args: Record<string, string>): Promise<void> {
  try {
    const uri = args['--uri'];
    if (!uri) {
      fail('add-to-queue requires --uri');
      return;
    }

    const headers = await authHeaders();
    const deviceId = args['--device-id'];
    const params: Record<string, string> = { uri };
    if (deviceId) params['device_id'] = deviceId;

    const response = await httpsPost(
      `${BASE}/me/player/queue?${querystring.stringify(params)}`,
      headers,
      '{}'
    );

    if (response.statusCode === 204) {
      ok({ message: `Added ${uri} to queue.` });
      return;
    }

    if (checkError(response, 'add-to-queue')) return;
    ok({ message: `Added ${uri} to queue.` });
  } catch (e: unknown) {
    fail(`add-to-queue failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function setVolume(args: Record<string, string>): Promise<void> {
  try {
    const volume = args['--volume'];
    if (!volume) {
      fail('set-volume requires --volume (0-100)');
      return;
    }

    const vol = parseInt(volume, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      fail('--volume must be a number between 0 and 100');
      return;
    }

    const headers = await authHeaders();
    const deviceId = args['--device-id'];
    const params: Record<string, string> = { volume_percent: String(vol) };
    if (deviceId) params['device_id'] = deviceId;

    const response = await httpsPut(
      `${BASE}/me/player/volume?${querystring.stringify(params)}`,
      headers,
      '{}'
    );

    if (response.statusCode === 204) {
      ok({ message: `Volume set to ${vol}%.` });
      return;
    }

    if (checkError(response, 'set-volume')) return;
    ok({ message: `Volume set to ${vol}%.` });
  } catch (e: unknown) {
    fail(`set-volume failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function listDevices(_args: Record<string, string>): Promise<void> {
  try {
    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/me/player/devices`, headers);

    if (checkError(response, 'list-devices')) return;

    const data = response.body as Record<string, unknown>;
    const devices = (data['devices'] as Array<Record<string, unknown>> || []).map((d) => ({
      id: d['id'],
      name: d['name'],
      type: d['type'],
      is_active: d['is_active'],
      volume_percent: d['volume_percent'],
    }));

    ok({ devices });
  } catch (e: unknown) {
    fail(`list-devices failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getRecommendations(args: Record<string, string>): Promise<void> {
  try {
    const seedTracks = args['--seed-tracks'];
    const seedArtists = args['--seed-artists'];
    const seedGenres = args['--seed-genres'];
    const limit = args['--limit'] || '10';

    if (!seedTracks && !seedArtists && !seedGenres) {
      fail('get-recommendations requires at least one of --seed-tracks, --seed-artists, --seed-genres');
      return;
    }

    const headers = await authHeaders();
    const params: Record<string, string> = { limit };
    if (seedTracks) params['seed_tracks'] = seedTracks;
    if (seedArtists) params['seed_artists'] = seedArtists;
    if (seedGenres) params['seed_genres'] = seedGenres;

    const response = await httpsGet(
      `${BASE}/recommendations?${querystring.stringify(params)}`,
      headers
    );

    if (checkError(response, 'get-recommendations')) return;

    const data = response.body as Record<string, unknown>;
    const tracks = (data['tracks'] as Array<Record<string, unknown>> || []).map((track) => ({
      id: track['id'],
      name: track['name'],
      uri: track['uri'],
      artists: (track['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']),
      album: (track['album'] as Record<string, unknown>)?.['name'],
      duration_ms: track['duration_ms'],
    }));

    ok({ tracks });
  } catch (e: unknown) {
    fail(`get-recommendations failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getTrack(args: Record<string, string>): Promise<void> {
  try {
    const trackId = args['--track-id'];
    if (!trackId) {
      fail('get-track requires --track-id');
      return;
    }

    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/tracks/${encodeURIComponent(trackId)}`, headers);

    if (checkError(response, 'get-track')) return;

    const track = response.body as Record<string, unknown>;
    ok({
      id: track['id'],
      name: track['name'],
      uri: track['uri'],
      artists: (track['artists'] as Array<Record<string, unknown>>)?.map((a) => ({
        id: a['id'],
        name: a['name'],
      })),
      album: {
        id: (track['album'] as Record<string, unknown>)?.['id'],
        name: (track['album'] as Record<string, unknown>)?.['name'],
        release_date: (track['album'] as Record<string, unknown>)?.['release_date'],
      },
      duration_ms: track['duration_ms'],
      popularity: track['popularity'],
      explicit: track['explicit'],
      preview_url: track['preview_url'],
    });
  } catch (e: unknown) {
    fail(`get-track failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getArtist(args: Record<string, string>): Promise<void> {
  try {
    const artistId = args['--artist-id'];
    if (!artistId) {
      fail('get-artist requires --artist-id');
      return;
    }

    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/artists/${encodeURIComponent(artistId)}`, headers);

    if (checkError(response, 'get-artist')) return;

    const artist = response.body as Record<string, unknown>;
    ok({
      id: artist['id'],
      name: artist['name'],
      uri: artist['uri'],
      genres: artist['genres'],
      popularity: artist['popularity'],
      followers: (artist['followers'] as Record<string, unknown>)?.['total'],
    });
  } catch (e: unknown) {
    fail(`get-artist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getAlbum(args: Record<string, string>): Promise<void> {
  try {
    const albumId = args['--album-id'];
    if (!albumId) {
      fail('get-album requires --album-id');
      return;
    }

    const headers = await authHeaders();
    const response = await httpsGet(`${BASE}/albums/${encodeURIComponent(albumId)}`, headers);

    if (checkError(response, 'get-album')) return;

    const album = response.body as Record<string, unknown>;
    const tracksData = album['tracks'] as Record<string, unknown>;
    const trackItems = tracksData?.['items'] as Array<Record<string, unknown>> || [];

    ok({
      id: album['id'],
      name: album['name'],
      uri: album['uri'],
      artists: (album['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']),
      release_date: album['release_date'],
      total_tracks: album['total_tracks'],
      label: album['label'],
      popularity: album['popularity'],
      tracks: trackItems.map((t) => ({
        id: t['id'],
        name: t['name'],
        uri: t['uri'],
        track_number: t['track_number'],
        duration_ms: t['duration_ms'],
        artists: (t['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']),
      })),
    });
  } catch (e: unknown) {
    fail(`get-album failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function createPlaylist(args: Record<string, string>): Promise<void> {
  try {
    const name = args['--name'];
    if (!name) {
      fail('create-playlist requires --name');
      return;
    }

    const description = args['--description'] || '';
    const isPublic = args['--public'] !== 'false';

    const headers = await authHeaders();

    // Get current user ID first
    const meResponse = await httpsGet(`${BASE}/me`, headers);
    if (checkError(meResponse, 'create-playlist (get user)')) return;

    const me = meResponse.body as Record<string, unknown>;
    const userId = me['id'] as string;

    const body = JSON.stringify({
      name,
      description,
      public: isPublic,
    });

    const response = await httpsPost(
      `${BASE}/users/${encodeURIComponent(userId)}/playlists`,
      headers,
      body
    );

    if (checkError(response, 'create-playlist')) return;

    const playlist = response.body as Record<string, unknown>;
    ok({
      id: playlist['id'],
      name: playlist['name'],
      uri: playlist['uri'],
      description: playlist['description'],
      public: playlist['public'],
    });
  } catch (e: unknown) {
    fail(`create-playlist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function addToPlaylist(args: Record<string, string>): Promise<void> {
  try {
    const playlistId = args['--playlist-id'];
    const uris = args['--uris'];

    if (!playlistId || !uris) {
      fail('add-to-playlist requires --playlist-id and --uris');
      return;
    }

    const uriList = uris.split(',').map((u) => u.trim()).filter(Boolean);
    if (uriList.length === 0) {
      fail('--uris must contain at least one URI');
      return;
    }

    const headers = await authHeaders();
    const body = JSON.stringify({ uris: uriList });

    const response = await httpsPost(
      `${BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`,
      headers,
      body
    );

    if (checkError(response, 'add-to-playlist')) return;

    ok({ message: `Added ${uriList.length} track(s) to playlist.` });
  } catch (e: unknown) {
    fail(`add-to-playlist failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function savedTracks(args: Record<string, string>): Promise<void> {
  try {
    const limit = args['--limit'] || '20';
    const headers = await authHeaders();
    const params = querystring.stringify({ limit });
    const response = await httpsGet(`${BASE}/me/tracks?${params}`, headers);

    if (checkError(response, 'saved-tracks')) return;

    const data = response.body as Record<string, unknown>;
    const items = data['items'] as Array<Record<string, unknown>> || [];

    const tracks = items.map((item) => {
      const track = item['track'] as Record<string, unknown>;
      return {
        id: track['id'],
        name: track['name'],
        uri: track['uri'],
        artists: (track['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']),
        album: (track['album'] as Record<string, unknown>)?.['name'],
        duration_ms: track['duration_ms'],
        added_at: item['added_at'],
      };
    });

    ok({ total: data['total'], tracks });
  } catch (e: unknown) {
    fail(`saved-tracks failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function saveTrack(args: Record<string, string>): Promise<void> {
  try {
    const trackId = args['--track-id'];
    if (!trackId) {
      fail('save-track requires --track-id');
      return;
    }

    const headers = await authHeaders();
    const params = querystring.stringify({ ids: trackId });
    const response = await httpsPut(`${BASE}/me/tracks?${params}`, headers, '{}');

    if (response.statusCode === 200 || response.statusCode === 204) {
      ok({ message: `Track ${trackId} saved to library.` });
      return;
    }

    if (checkError(response, 'save-track')) return;
    ok({ message: `Track ${trackId} saved to library.` });
  } catch (e: unknown) {
    fail(`save-track failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function removeTrack(args: Record<string, string>): Promise<void> {
  try {
    const trackId = args['--track-id'];
    if (!trackId) {
      fail('remove-track requires --track-id');
      return;
    }

    const headers = await authHeaders();
    const params = querystring.stringify({ ids: trackId });
    const response = await httpsDelete(`${BASE}/me/tracks?${params}`, headers);

    if (response.statusCode === 200 || response.statusCode === 204) {
      ok({ message: `Track ${trackId} removed from library.` });
      return;
    }

    if (checkError(response, 'remove-track')) return;
    ok({ message: `Track ${trackId} removed from library.` });
  } catch (e: unknown) {
    fail(`remove-track failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function topItems(args: Record<string, string>): Promise<void> {
  try {
    const type = args['--type'];
    if (!type || !['artists', 'tracks'].includes(type)) {
      fail('top-items requires --type (artists or tracks)');
      return;
    }

    const limit = args['--limit'] || '20';
    const timeRange = args['--time-range'] || 'medium_term';

    const validTimeRanges = ['short_term', 'medium_term', 'long_term'];
    if (!validTimeRanges.includes(timeRange)) {
      fail(`--time-range must be one of: ${validTimeRanges.join(', ')}`);
      return;
    }

    const headers = await authHeaders();
    const params = querystring.stringify({ limit, time_range: timeRange });
    const response = await httpsGet(`${BASE}/me/top/${encodeURIComponent(type)}?${params}`, headers);

    if (checkError(response, 'top-items')) return;

    const data = response.body as Record<string, unknown>;
    const items = data['items'] as Array<Record<string, unknown>> || [];

    const formatted = items.map((item) => {
      const base: Record<string, unknown> = {
        id: item['id'],
        name: item['name'],
        uri: item['uri'],
      };

      if (type === 'tracks') {
        base['artists'] = (item['artists'] as Array<Record<string, unknown>>)?.map((a) => a['name']);
        base['album'] = (item['album'] as Record<string, unknown>)?.['name'];
        base['duration_ms'] = item['duration_ms'];
        base['popularity'] = item['popularity'];
      } else {
        base['genres'] = item['genres'];
        base['popularity'] = item['popularity'];
        base['followers'] = (item['followers'] as Record<string, unknown>)?.['total'];
      }

      return base;
    });

    ok({ type, time_range: timeRange, total: data['total'], items: formatted });
  } catch (e: unknown) {
    fail(`top-items failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function helpCommand(): void {
  ok({
    commands: [
      { command: 'now-playing', description: 'Get the currently playing track' },
      { command: 'play', flags: ['--uri <uri> (optional)', '--device-id <id> (optional)'], description: 'Resume or play a specific URI' },
      { command: 'pause', flags: ['--device-id <id> (optional)'], description: 'Pause playback' },
      { command: 'next', flags: ['--device-id <id> (optional)'], description: 'Skip to next track' },
      { command: 'previous', flags: ['--device-id <id> (optional)'], description: 'Skip to previous track' },
      { command: 'search', flags: ['--query <q>', '--type <track|album|artist|playlist>', '--limit N (optional, default 10)'], description: 'Search Spotify' },
      { command: 'get-playlist', flags: ['--playlist-id <id>'], description: 'Get playlist details and tracks' },
      { command: 'list-playlists', flags: ['--limit N (optional, default 20)'], description: "List current user's playlists" },
      { command: 'get-queue', description: 'Get current playback queue' },
      { command: 'add-to-queue', flags: ['--uri <uri>', '--device-id <id> (optional)'], description: 'Add a track to the queue' },
      { command: 'set-volume', flags: ['--volume <0-100>', '--device-id <id> (optional)'], description: 'Set playback volume' },
      { command: 'list-devices', description: 'List available playback devices' },
      { command: 'get-recommendations', flags: ['--seed-tracks <ids>', '--seed-artists <ids>', '--seed-genres <genres>', '--limit N (optional)'], description: 'Get track recommendations' },
      { command: 'get-track', flags: ['--track-id <id>'], description: 'Get track details' },
      { command: 'get-artist', flags: ['--artist-id <id>'], description: 'Get artist details' },
      { command: 'get-album', flags: ['--album-id <id>'], description: 'Get album details' },
      { command: 'create-playlist', flags: ['--name <name>', '--description <desc> (optional)', '--public true|false (optional, default true)'], description: 'Create a new playlist' },
      { command: 'add-to-playlist', flags: ['--playlist-id <id>', '--uris <uri1,uri2,...>'], description: 'Add tracks to a playlist' },
      { command: 'saved-tracks', flags: ['--limit N (optional, default 20)'], description: "Get user's saved/liked tracks" },
      { command: 'save-track', flags: ['--track-id <id>'], description: "Save a track to user's library" },
      { command: 'remove-track', flags: ['--track-id <id>'], description: "Remove a track from user's library" },
      { command: 'top-items', flags: ['--type <artists|tracks>', '--limit N (optional)', '--time-range <short_term|medium_term|long_term> (optional)'], description: "Get user's top artists or tracks" },
      { command: 'help', description: 'Show available commands' },
    ],
    env_required: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN'],
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command: string; args: Record<string, string> } {
  const command = argv[2] || '';
  const args: Record<string, string> = {};

  let i = 3;
  while (i < argv.length) {
    const key = argv[i];
    if (key.startsWith('--')) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        args[key] = 'true';
      } else {
        args[key] = argv[i + 1];
        i++;
      }
    }
    i++;
  }

  return { command, args };
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv);

  switch (command) {
    case 'now-playing':
      await nowPlaying(args);
      break;
    case 'play':
      await play(args);
      break;
    case 'pause':
      await pause(args);
      break;
    case 'next':
      await next(args);
      break;
    case 'previous':
      await previous(args);
      break;
    case 'search':
      await search(args);
      break;
    case 'get-playlist':
      await getPlaylist(args);
      break;
    case 'list-playlists':
      await listPlaylists(args);
      break;
    case 'get-queue':
      await getQueue(args);
      break;
    case 'add-to-queue':
      await addToQueue(args);
      break;
    case 'set-volume':
      await setVolume(args);
      break;
    case 'list-devices':
      await listDevices(args);
      break;
    case 'get-recommendations':
      await getRecommendations(args);
      break;
    case 'get-track':
      await getTrack(args);
      break;
    case 'get-artist':
      await getArtist(args);
      break;
    case 'get-album':
      await getAlbum(args);
      break;
    case 'create-playlist':
      await createPlaylist(args);
      break;
    case 'add-to-playlist':
      await addToPlaylist(args);
      break;
    case 'saved-tracks':
      await savedTracks(args);
      break;
    case 'save-track':
      await saveTrack(args);
      break;
    case 'remove-track':
      await removeTrack(args);
      break;
    case 'top-items':
      await topItems(args);
      break;
    case 'help':
      helpCommand();
      break;
    default:
      fail(
        `Unknown command: "${command}". Run with "help" to see available commands.`
      );
      break;
  }
}

main().catch((e) => {
  fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});