/*
 * বইয়ের পোকা / Bookworms — cloud configuration
 *
 * The OAuth client ID is a public identifier, not a password. Bookworms asks for
 * Google's non-sensitive drive.appdata scope, which can access only Bookworms'
 * hidden app-data folder inside the Google account the reader chooses.
 *
 * 1. Create a Google Cloud project and enable Google Drive API.
 * 2. Configure the OAuth consent screen.
 * 3. Create a Web application OAuth client with your GitHub Pages origin.
 * 4. Paste its client ID below and change enabled to true.
 */
window.BOOKWORMS_CLOUD_CONFIG = Object.freeze({
  enabled: true,
  googleClientId: "1007920998278-vf6qetnkdt6fmlm4fmt7q1ekbqop6oke.apps.googleusercontent.com"
});
