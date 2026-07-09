export const USER_ROLES = ['super_admin', 'admin', 'employee']

export const ASSIGNABLE_ROLES_BY_ACTOR = {
  super_admin: ['super_admin', 'admin', 'employee'],
  admin: ['admin', 'employee'],
  employee: [],
}

export function isSuperAdmin(role) {
  return role === 'super_admin'
}

export function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin'
}

export function isPrivilegedRole(role) {
  return isAdminRole(role)
}

export function roleHasPermission(userRole, allowedRole) {
  if (allowedRole === 'admin') {
    return isAdminRole(userRole)
  }
  return userRole === allowedRole
}

export function canAssignRole(actorRole, targetRole) {
  const allowed = ASSIGNABLE_ROLES_BY_ACTOR[actorRole] || []
  return allowed.includes(targetRole)
}

/** Regular admins cannot modify or delete Super Admin accounts. */
export function canAdminManageUser(actor, targetUser) {
  if (!targetUser) return false
  if (isSuperAdmin(targetUser.role) && !isSuperAdmin(actor?.role)) {
    return false
  }
  return true
}
