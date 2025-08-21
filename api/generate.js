// Serverless function to proxy Gemini requests.
//
// This function runs on the Vercel Edge/Serverless runtime. It accepts POST
// requests from the client, forwards them to your configured Gemini backend
// (a Cloud Function or other API) and returns the response. By handling the
// request server‑side, you avoid exposing API keys or other secrets to the
// client bundle.

export default async function handler(req, res) {
  // Only allow POST requests. Reject anything else with a 405 response.
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // Parse the JSON body from the request. Vercel automatically handles
    // JSON parsing when using Edge/Serverless functions, but we defensively
    // check that a body exists.
    const body = req.body ?? {};

    // Pull the backend URL from an environment variable. You should set
    // GEMINI_BACKEND_URL in Vercel → Project Settings → Environment Variables.
    // For example, this could point at your existing Cloud Function that
    // wraps the Gemini API. By keeping the value in an env var you can
    // change it without committing secrets.
    const backendUrl = process.env.GEMINI_BACKEND_URL;

    if (!backendUrl) {
      res.status(500).json({ error: 'GEMINI_BACKEND_URL is not configured' });
      return;
    }

    // Forward the request to the backend. We do not add an Authorization
    // header here because the backend should already enforce authentication and
    // use its own credentials. Adjust as needed for your infrastructure.
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    // Catch any unexpected errors to prevent leaking stack traces to clients.
    console.error('Error in generate proxy:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
