/**
 * Email service using Gmail SMTP (same as Patreon Helpdesk).
 */

import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER || 'team@example.com',
    pass: process.env.SMTP_PASS || '',
  },
});

export async function sendEmail(to: string, subject: string, html: string, attachments?: { filename: string; content: string }[]): Promise<boolean> {
  if (!process.env.SMTP_PASS) {
    console.log(`[email] SMTP not configured. Would send to ${to}: ${subject}`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: `"YT Testing" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      attachments,
    });
    console.log(`[email] Sent to ${to}: ${subject}`);
    return true;
  } catch (err: any) {
    console.error(`[email] Failed: ${err.message}`);
    return false;
  }
}

export async function sendTestCompleteEmail(testTitle: string, winnerLabel: string, testId: number): Promise<void> {
  const to = process.env.NOTIFICATION_EMAIL || 'team@example.com';
  await sendEmail(to, `Test Complete: ${testTitle}`, `
    <div style="font-family:Helvetica Neue,sans-serif;max-width:500px;margin:0 auto;padding:40px 20px">
      <h2 style="color:#7c63ff">Test Complete</h2>
      <p>The A/B test for "<strong>${testTitle}</strong>" has completed.</p>
      <p>Winner: <strong>Variant ${winnerLabel}</strong></p>
      <p style="font-size:13px;color:#888">These numbers are preliminary. YouTube underreports the most recent hours of data, so the results keep correcting for 48 hours. The winner is re-checked automatically as the data settles, and a final settled report will follow.</p>
      <p style="margin-top:24px">
        <a href="https://app.example.com/tests/${testId}" style="background:#7c63ff;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500">
          View Results
        </a>
      </p>
    </div>
  `);
}

export async function sendSettledReportEmail(opts: {
  testId: number;
  testTitle: string;
  winnerLabel: string;
  stats: { label: string; title: string | null; impressions: number; views: number; vpi: number; watchHours: number }[];
  flip: { from: string; to: string; at: string } | null;
}): Promise<void> {
  const to = process.env.NOTIFICATION_EMAIL || 'team@example.com';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = opts.stats.map(v => `
    <tr style="${v.label === opts.winnerLabel ? 'background:#f3f0ff;font-weight:600' : ''}">
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(v.label)}${v.label === opts.winnerLabel ? ' &#127942;' : ''}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${v.title ? esc(v.title) : '<span style="color:#aaa">thumbnail only</span>'}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${v.vpi.toFixed(2)}%</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${v.impressions.toLocaleString()}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${v.views.toLocaleString()}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${v.watchHours.toLocaleString()}</td>
    </tr>`).join('');
  const flipNote = opts.flip ? `
    <p style="background:#fff7e6;border:1px solid #f0d9a8;border-radius:8px;padding:10px 14px;font-size:13px">
      <strong>Winner changed during settling:</strong> the live data pointed to Variant ${esc(opts.flip.from)} when the test finished,
      but the settled numbers show Variant ${esc(opts.flip.to)} actually won. The correct variant has been applied to the video.
    </p>` : '';
  await sendEmail(to, `Final Settled Results: ${opts.testTitle}`, `
    <div style="font-family:Helvetica Neue,sans-serif;max-width:640px;margin:0 auto;padding:40px 20px">
      <h2 style="color:#7c63ff">Final Settled Results</h2>
      <p>YouTube has finished settling the data for "<strong>${esc(opts.testTitle)}</strong>". These are the confirmed final numbers.</p>
      <p>Winner: <strong>Variant ${esc(opts.winnerLabel)}</strong></p>
      ${flipNote}
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:12px">
        <tr style="text-align:left;color:#888">
          <th style="padding:8px 10px">Variant</th>
          <th style="padding:8px 10px">Title</th>
          <th style="padding:8px 10px;text-align:right">CTR</th>
          <th style="padding:8px 10px;text-align:right">Impressions</th>
          <th style="padding:8px 10px;text-align:right">Views</th>
          <th style="padding:8px 10px;text-align:right">Watch hrs</th>
        </tr>
        ${rows}
      </table>
      <p style="font-size:12px;color:#888;margin-top:10px">CTR here is views per impression, the same metric the winner is decided on.</p>
      <p style="margin-top:24px">
        <a href="https://app.example.com/tests/${opts.testId}" style="background:#7c63ff;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500">
          View Full Results
        </a>
      </p>
    </div>
  `);
}
