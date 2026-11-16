// Starts Tandem's sync server.   npm start   (PORT defaults to 8686)

import { createSyncServer } from './app.ts';
import { config } from './config.ts';

const { httpServer } = createSyncServer();
httpServer.listen(config.port, () => {
  console.log(`Tandem sync server listening on port ${config.port}`);
});
