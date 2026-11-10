"""Проекты, членство и приглашения в независимый сервис."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .auth import (
    Principal,
    authenticate,
    cabinet,
    create_invitation,
    db_session,
    owner,
    project_role,
    user_json,
)
from .models import Credential, Invitation, Membership, Project, ProjectOrigin, User
from .schemas import MemberCreate, ProjectCreate, UserCreate, UserState

router = APIRouter(prefix="/api")


def project_json(db: Session, project: Project, role: str) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "role": role,
        "origins": list(
            db.scalars(
                select(ProjectOrigin.origin)
                .where(ProjectOrigin.project_id == project.id)
                .order_by(ProjectOrigin.origin)
            )
        ),
    }


@router.get("/projects")
def projects(principal: Principal = Depends(authenticate), db: Session = Depends(db_session)):
    query = select(Project).order_by(Project.name, Project.id)
    if not principal.user.owner:
        query = query.where(
            Project.id.in_(
                select(Membership.project_id).where(Membership.user_id == principal.user.id)
            )
        )
    if not principal.cookie:
        query = query.where(Project.id.in_(principal.credential.project_ids))
    return [project_json(db, row, project_role(db, principal, row.id)) for row in db.scalars(query)]


@router.post("/projects", status_code=201)
def create_project(
    body: ProjectCreate, principal: Principal = Depends(owner), db: Session = Depends(db_session)
):
    project = Project(name=body.name)
    db.add(project)
    db.flush()
    db.add(Membership(project_id=project.id, user_id=principal.user.id, role="owner"))
    for origin in body.origins:
        db.add(ProjectOrigin(project_id=project.id, origin=origin))
    db.commit()
    return project_json(db, project, "owner")


@router.put("/projects/{project_id}")
def edit_project(
    project_id: str,
    body: ProjectCreate,
    principal: Principal = Depends(cabinet),
    db: Session = Depends(db_session),
):
    if project_role(db, principal, project_id) != "owner":
        raise HTTPException(403, "Нужны права владельца проекта")
    project = db.get(Project, project_id)
    project.name = body.name
    from sqlalchemy import delete

    db.execute(delete(ProjectOrigin).where(ProjectOrigin.project_id == project_id))
    for origin in body.origins:
        db.add(ProjectOrigin(project_id=project_id, origin=origin))
    db.commit()
    return project_json(db, project, "owner")


@router.get("/projects/{project_id}/members")
def members(
    project_id: str, principal: Principal = Depends(cabinet), db: Session = Depends(db_session)
):
    project_role(db, principal, project_id)
    rows = db.execute(
        select(User, Membership.role)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.project_id == project_id)
    )
    return [{**user_json(user), "role": role} for user, role in rows]


@router.post("/projects/{project_id}/members", status_code=201)
def add_member(
    project_id: str,
    body: MemberCreate,
    principal: Principal = Depends(cabinet),
    db: Session = Depends(db_session),
):
    if project_role(db, principal, project_id) != "owner":
        raise HTTPException(403, "Нужны права владельца проекта")
    user = db.scalar(select(User).where(User.email == body.email.strip().casefold()))
    if user is None:
        raise HTTPException(422, "Сначала создайте аккаунт участника")
    db.execute(
        insert(Membership)
        .values(project_id=project_id, user_id=user.id, role=body.role)
        .on_conflict_do_update(
            index_elements=[Membership.project_id, Membership.user_id], set_={"role": body.role}
        )
    )
    db.commit()
    return {**user_json(user), "role": body.role}


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def remove_member(
    project_id: str,
    user_id: str,
    principal: Principal = Depends(cabinet),
    db: Session = Depends(db_session),
):
    if project_role(db, principal, project_id) != "owner":
        raise HTTPException(403, "Нужны права владельца проекта")
    membership = db.get(Membership, (project_id, user_id))
    if membership is None:
        raise HTTPException(404, "Участник недоступен")
    if user_id == principal.user.id:
        raise HTTPException(409, "Нельзя удалить себя из проекта")
    db.delete(membership)
    db.commit()


@router.get("/users")
def users(principal: Principal = Depends(owner), db: Session = Depends(db_session)):
    return [user_json(row) for row in db.scalars(select(User).order_by(User.created_at))]


@router.post("/users", status_code=201)
def invite(
    body: UserCreate, principal: Principal = Depends(owner), db: Session = Depends(db_session)
):
    """Создаёт аккаунт без пароля и одноразовую ссылку; письма автоматически не отправляет."""
    if db.scalar(select(User.id).where(User.email == body.email)):
        raise HTTPException(409, "Аккаунт с этим email уже существует")
    user = User(email=body.email, name=body.name)
    db.add(user)
    db.flush()
    raw = create_invitation(db, user)
    db.commit()
    return {**user_json(user), "activationToken": raw}


@router.post("/users/{user_id}/invitation", status_code=201)
def renew_invitation(
    user_id: str, principal: Principal = Depends(owner), db: Session = Depends(db_session)
):
    user = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None or user.active:
        raise HTTPException(409, "Приглашение доступно только неактивированному аккаунту")
    db.execute(update(Invitation).where(Invitation.user_id == user_id).values(used=True))
    raw = create_invitation(db, user)
    db.commit()
    return {"activationToken": raw}


@router.patch("/users/{user_id}")
def user_state(
    user_id: str,
    body: UserState,
    principal: Principal = Depends(owner),
    db: Session = Depends(db_session),
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "Аккаунт недоступен")
    if user.owner or (body.active and not user.password_hash):
        raise HTTPException(409, "Для этого аккаунта изменение недоступно")
    if not body.active:
        db.execute(update(Credential).where(Credential.user_id == user.id).values(revoked=True))
    user.active = body.active
    db.commit()
    return user_json(user)
