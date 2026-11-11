This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Sharing files into GlobalSend

On supported Android browsers, install GlobalSend from its HTTPS site, then share files from another app and choose GlobalSend. The files appear on the transfer page; connect to a peer and send them as usual. The share target requires the service worker to be registered before sharing. Existing installations may need to be reinstalled or updated before Android registers the new share target.

Shared files are temporarily stored in the browser's local IndexedDB and removed from that store when the transfer page reads them. Very large shares may fail if browser storage is insufficient; use the in-app file picker instead. The app requires a network connection to load the transfer page and connect to a peer.

The separate photos/videos picker requests media types only, allowing supported Android browsers to use the system photo picker, including configured cloud photo providers. The exact picker is controlled by the browser and device. iOS does not support receiving shares into a PWA; use either in-app picker there instead. A native iOS app with a share extension would be needed for share-sheet integration.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
