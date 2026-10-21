// ESM-style usage sites (scanned as text; never executed by the fixture suite)
import { z } from 'zod';
import 'tiny-lib';
import { pad } from 'tiny-lib/sub';
import unrelated from 'zodish';

export const parse = (data) => z.object({ name: z.string() }).parse(data);
export const padded = pad('x');
