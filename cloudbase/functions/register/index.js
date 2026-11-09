'use strict';

const { createRegistrationServer, ENV_ID } = require('./server.cjs');

function createCloudBaseServices(manager) {
  // CloudBase supplies rotating, short-lived credentials through the function
  // execution role. Never put Tencent Cloud account keys in source or config.
  const app = manager.init({ envId: ENV_ID, region: 'ap-shanghai', timeout: 7000 });
  async function queryBoolean(sql) {
    const result = await app.commonService().call({ Action: 'ExecutePGSql', Param: { EnvId: ENV_ID, Sql: sql } });
    if (!Array.isArray(result?.Rows) || result.Rows.length !== 1 || typeof result.Rows[0] !== 'string') throw new Error('Invalid registration database response.');
    const row = JSON.parse(result.Rows[0]);
    if (!Array.isArray(row) || row.length !== 1 || ![true, false, 'true', 'false'].includes(row[0])) throw new Error('Invalid registration database response.');
    return row[0] === true || row[0] === 'true';
  }
  return {
    async consumeSlot(hash) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid registration bucket.');
      return queryBoolean(`select community_private.consume_registration_slot('${hash}') as allowed;`);
    },
    async reserveName(username) {
      if (typeof username !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$/.test(username)) throw new Error('Invalid registration username.');
      return queryBoolean(`select community_private.reserve_registration_name('${username}') as allowed;`);
    },
    createUser: input => app.user.createUser(input)
  };
}

if (require.main === module) {
  const manager = require('@cloudbase/manager-node');
  // The production HTTP gateway supplies CORS headers; sending another set
  // here makes Access-Control-Allow-Origin invalid in browsers.
  createRegistrationServer({ ...createCloudBaseServices(manager), gatewayCors: true }).listen(9000, '0.0.0.0');
}

module.exports = { createCloudBaseServices };
