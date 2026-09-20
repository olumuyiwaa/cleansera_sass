jest.mock('../src/config/database.js', () => ({}));
const { upsertGuestCustomer } = require('../src/modules/widget/widget.service');

describe('widget.service.upsertGuestCustomer', () => {
  test('never rewrites contact details of an existing customer', async () => {
    const client = { customer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) } };
    await upsertGuestCustomer(client, 'biz1', { firstName: 'Eve', lastName: 'Attacker', email: 'eve@evil.test', phone: '+31611111111' });
    const arg = client.customer.upsert.mock.calls[0][0];
    expect(arg.update).toEqual({});
    expect(arg.create).toMatchObject({ businessId: 'biz1', email: 'eve@evil.test', phone: '+31611111111' });
  });
});
