import { config } from "dotenv";
config({ path: ".env" });
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);

const uid = "did:privy:cmnxin9y800dk0cjpk75pe0hl";
const completed = await sql`SELECT count(*) FROM payments WHERE user_id = ${uid} AND type = 'bill' AND status = 'completed'`;
console.log("Completed bill payments for this user:", completed[0].count);

const all = await sql`SELECT status, count(*) FROM payments WHERE user_id = ${uid} AND type = 'bill' GROUP BY status`;
console.log("Breakdown by status:", all);
