import { getAccessToken } from '../services/youtube-auth.js';
import { google } from 'googleapis';
import { config } from '../config.js';

async function main() {
  const token = await getAccessToken();
  console.log('Got access token');

  const auth = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  auth.setCredentials({ access_token: token });
  const yt = google.youtube({ version: 'v3', auth });

  // Get uploads playlist
  const channelRes = await yt.channels.list({ part: ['contentDetails'], mine: true });
  const uploadsPlaylist = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  console.log('Uploads playlist:', uploadsPlaylist);

  // List recent uploads (includes scheduled)
  const res = await yt.playlistItems.list({
    part: ['snippet', 'status', 'contentDetails'],
    playlistId: uploadsPlaylist!,
    maxResults: 15,
  });

  console.log(`\nFound ${res.data.items?.length} videos:\n`);
  for (const item of res.data.items || []) {
    const videoId = item.contentDetails?.videoId;
    // Get full video details including status
    const videoRes = await yt.videos.list({
      part: ['snippet', 'status', 'contentDetails', 'statistics'],
      id: [videoId!],
    });
    const v = videoRes.data.items?.[0];
    const privacy = v?.status?.privacyStatus;
    const publishAt = v?.status?.publishAt;
    const dur = v?.contentDetails?.duration;
    console.log(`${privacy?.padEnd(10)} | ${publishAt || v?.snippet?.publishedAt?.split('T')[0] || '?'} | ${dur?.padEnd(8)} | ${v?.snippet?.title}`);
  }
}

main().catch(console.error);
