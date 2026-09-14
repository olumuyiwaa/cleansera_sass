'use strict';

const inventoryService = require('./inventory.service');
const {
  createItemSchema,
  updateItemSchema,
  createLocationSchema,
  updateLocationSchema,
  createMovementSchema,
  jobUsageSchema,
} = require('./inventory.validation');

function getBusinessId(req) {
  // Assumes your existing middleware attaches the resolved tenant
  return req.business?.id || req.user?.businessId;
}

async function listItems(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const result = await inventoryService.listItems(businessId, {
      type: req.query.type,
      isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
      search: req.query.search,
      page: Number(req.query.page) || 1,
      limit: Math.min(Number(req.query.limit) || 50, 100),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getItem(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const item = await inventoryService.getItem(businessId, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    next(err);
  }
}

async function createItem(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createItemSchema.parse(req.body);
    const item = await inventoryService.createItem(businessId, data);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
}

async function updateItem(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateItemSchema.parse(req.body);
    const item = await inventoryService.updateItem(businessId, req.params.id, data);
    res.json(item);
  } catch (err) {
    next(err);
  }
}

async function listLocations(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const locations = await inventoryService.listLocations(businessId);
    res.json(locations);
  } catch (err) {
    next(err);
  }
}

async function createLocation(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createLocationSchema.parse(req.body);
    const location = await inventoryService.createLocation(businessId, data);
    res.status(201).json(location);
  } catch (err) {
    next(err);
  }
}

async function updateLocation(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateLocationSchema.parse(req.body);
    const location = await inventoryService.updateLocation(businessId, req.params.id, data);
    res.json(location);
  } catch (err) {
    next(err);
  }
}

async function getStock(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const stock = await inventoryService.getStock(businessId, {
      locationId: req.query.locationId,
      lowStockOnly: req.query.lowStock === 'true',
    });
    res.json(stock);
  } catch (err) {
    next(err);
  }
}

async function createMovement(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createMovementSchema.parse(req.body);
    const movement = await inventoryService.createMovement(
      businessId,
      data,
      req.user?.id
    );
    res.status(201).json(movement);
  } catch (err) {
    next(err);
  }
}

async function recordJobUsage(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = jobUsageSchema.parse(req.body);
    const usage = await inventoryService.recordJobUsage(
      businessId,
      req.params.bookingId,
      data,
      req.user?.id
    );
    res.status(201).json(usage);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listItems,
  getItem,
  createItem,
  updateItem,
  listLocations,
  createLocation,
  updateLocation,
  getStock,
  createMovement,
  recordJobUsage,
};
