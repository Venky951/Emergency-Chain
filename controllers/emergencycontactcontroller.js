const mongoose = require("mongoose");
const EmergencyContact = require("../models/emergencycontact");
const { catchAsync } = require("../utils/logger");
const { normalizePhone } = require("../utils/phone");

const MAX_EMERGENCY_CONTACTS = Math.max(
  1,
  Number(process.env.MAX_EMERGENCY_CONTACTS || 5),
);

const contactFields =
  "name relationship phone isActive verificationStatus createdAt updatedAt";

const validateContactFields = ({ name, relationship, phone }) => {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return { error: "A valid phone number is required." };
  }

  const normalizedName = String(name ?? "").trim();
  if (!normalizedName || normalizedName.length > 100) {
    return {
      error: "Contact name is required and must be 100 characters or less.",
    };
  }

  const normalizedRelationship = String(relationship ?? "").trim();
  if (!normalizedRelationship || normalizedRelationship.length > 50) {
    return {
      error: "Relationship is required and must be 50 characters or less.",
    };
  }

  return {
    value: {
      name: normalizedName,
      relationship: normalizedRelationship,
      phone: normalizedPhone,
    },
  };
};

exports.listContacts = catchAsync(async (req, res) => {
  const contacts = await EmergencyContact.find({ owner: req.session.userId })
    .sort({ createdAt: 1 })
    .select(contactFields)
    .lean();

  return res.status(200).json({ success: true, contacts });
});

exports.createContact = catchAsync(async (req, res) => {
  const validated = validateContactFields(req.body);
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  const activeCount = await EmergencyContact.countDocuments({
    owner: req.session.userId,
    isActive: true,
  });
  if (activeCount >= MAX_EMERGENCY_CONTACTS) {
    return res.status(409).json({
      error: `You can have at most ${MAX_EMERGENCY_CONTACTS} active emergency contacts.`,
    });
  }

  const contact = await EmergencyContact.create({
    owner: req.session.userId,
    ...validated.value,
  });

  return res.status(201).json({
    success: true,
    contact: await EmergencyContact.findById(contact._id)
      .select(contactFields)
      .lean(),
  });
});

exports.updateContact = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Emergency contact not found." });
  }

  const existing = await EmergencyContact.findOne({
    _id: req.params.id,
    owner: req.session.userId,
  });
  if (!existing) {
    return res.status(404).json({ error: "Emergency contact not found." });
  }

  const validated = validateContactFields({
    name: req.body.name ?? existing.name,
    relationship: req.body.relationship ?? existing.relationship,
    phone: req.body.phone ?? existing.phone,
  });
  if (validated.error) {
    return res.status(400).json({ error: validated.error });
  }

  existing.set(validated.value);
  await existing.save();

  return res.status(200).json({
    success: true,
    contact: await EmergencyContact.findById(existing._id)
      .select(contactFields)
      .lean(),
  });
});

exports.deactivateContact = catchAsync(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Emergency contact not found." });
  }

  const contact = await EmergencyContact.findOneAndUpdate(
    { _id: req.params.id, owner: req.session.userId, isActive: true },
    { $set: { isActive: false } },
    { new: true },
  )
    .select(contactFields)
    .lean();

  if (!contact) {
    return res.status(404).json({ error: "Emergency contact not found." });
  }

  return res.status(200).json({ success: true, contact });
});

exports.getMaxContacts = () => MAX_EMERGENCY_CONTACTS;
