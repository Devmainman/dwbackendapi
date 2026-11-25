export const validateEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
};

export const validatePassword = (password) => {
  return password.length >= 6;
};
  
export const validateMobileNumber = (mobile) => {
  if (!mobile || mobile.trim() === '') return true; // Optional field
  return /^\+[1-9]\d{1,14}$/.test(mobile); // E.164 format
};

export const validateUserInput = (email, password) => {
  if (!validateEmail(email)) {
    return { valid: false, message: 'Invalid email format' };
  }
  
  if (!validatePassword(password)) {
    return { valid: false, message: 'Password must be at least 6 characters' };
  }
  
  return { valid: true };
};
  
  export const validateAdminInput = (email, password) => {
    if (!validateEmail(email)) {
      return { valid: false, message: 'Invalid email format' };
    }
    
    if (!validatePassword(password)) {
      return { valid: false, message: 'Password must be at least 6 characters' };
    }
    
    return { valid: true };
  };
  
  // New validation functions for verification flow
  export const validateProfileData = (data) => {
    const { firstName, lastName, country, gender } = data;
    const mobile = data.phoneNumber ?? data.mobile; // the app sends phoneNumber
    const errors = {};
  
    if (!firstName || firstName.trim().length < 2) {
      errors.firstName = 'First name must be at least 2 characters';
    }
  
    if (!lastName || lastName.trim().length < 2) {
      errors.lastName = 'Last name must be at least 2 characters';
    }
  
    if (!validateMobileNumber(mobile)) {
      errors.phoneNumber = 'Enter the number in international format, e.g. +233201234567';
    }
  
    if (!country) {
      errors.country = 'Choose your country';
    }
  
    if (!gender) {
      errors.gender = 'Choose your gender';
    }
  
  
    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  };
  
  // Utility function to transform frontend data to backend format
  export const transformProfileData = (data) => {
    return {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      mobile: data.phoneNumber, // Transform phoneNumber to mobile
      country: data.country,
      gender: data.gender,
      currency: data.currency
    };
  };
  
  export const validateAddressData = (data) => {
    const { street, city, state, postalCode, country } = data;
    const errors = {};
  
    if (!street || street.trim().length < 3) {
      errors.street = 'Street address is required';
    }
  
    if (!city || city.trim().length < 2) {
      errors.city = 'City is required';
    }
  
    if (!state || state.trim().length < 2) {
      errors.state = 'State is required';
    }
  
    if (!postalCode || postalCode.trim().length < 3) {
      errors.postalCode = 'Postal code is required';
    }
  
    if (!country) {
      errors.country = 'Country is required';
    }
  
    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  };
  
  export const validateOTP = (otp) => {
    const re = /^\d{6}$/;
    return re.test(otp);
  };
/** Escape user input before building a RegExp (prevents ReDoS / regex injection). */
export const escapeRegex = (value) => String(value ?? '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Coerce a client value to a plain string (blocks {"$ne": ...} style payloads). */
export const asString = (value, max = 500) =>
  (typeof value === 'string' || typeof value === 'number') ? String(value).trim().slice(0, max) : '';
