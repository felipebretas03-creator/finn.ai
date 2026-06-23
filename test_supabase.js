require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function test() {
    console.log("Testing connection to", process.env.SUPABASE_URL);
    try {
        const { data, error } = await supabase.from('usuarios').select('*').limit(1);
        if (error) {
            console.error("Supabase Error:", error);
        } else {
            console.log("Success! Data:", data);
        }
    } catch (e) {
        console.error("Caught exception:", e);
    }
}
test();
