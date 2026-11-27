import { resedit } from '@electron/packager/resedit';

const [executable, iconPath] = process.argv.slice(2);
await resedit(executable, { iconPath });
