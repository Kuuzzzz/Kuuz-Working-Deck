import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { blobs } = await list({ prefix: 'portfolio/' });
    const images = blobs
      .filter((blob) => /\.(jpe?g|png|webp|gif)$/i.test(blob.pathname))
      .map((blob) => ({
        pathname: blob.pathname,
        url: blob.url,
        uploadedAt: blob.uploadedAt,
        size: blob.size,
      }))
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ images });
  } catch (error) {
    console.error('Unable to list portfolio images:', error);
    return res.status(500).json({ error: 'Image storage is not configured yet. Add Vercel Blob storage to this project.' });
  }
}
