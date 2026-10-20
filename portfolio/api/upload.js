import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.PORTFOLIO_UPLOAD_PASSWORD) {
    return res.status(503).json({ error: 'Upload setup is incomplete. Configure PORTFOLIO_UPLOAD_PASSWORD in Vercel project environment variables.' });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let payload;
        try {
          payload = JSON.parse(clientPayload || '{}');
        } catch {
          throw new Error('Invalid upload details.');
        }

        if (payload.password !== process.env.PORTFOLIO_UPLOAD_PASSWORD) {
          throw new Error('Incorrect portfolio upload password.');
        }

        const allowedProjects = new Set([
          'viso-pises',
          'walls-ice-cream',
          'isuzu',
          'breeze',
          'cement-brands',
          'campaign-development',
        ]);
        if (!allowedProjects.has(payload.project)) {
          throw new Error('Choose a valid portfolio project.');
        }

        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
          maximumSizeInBytes: 15 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ project: payload.project }),
        };
      },
      onUploadCompleted: async () => {},
    });

    return res.status(200).json(jsonResponse);
  } catch (error) {
    console.error('Portfolio upload failed:', error);
    return res.status(400).json({ error: error.message || 'Upload failed.' });
  }
}
