'use strict';
// usage of zod via require — scanned by dep-doctor's research step
const { z } = require('zod');

const schema = z.object({
  id: z.string().strict({ message: 'id must be a string' }),
});

module.exports = { schema };
